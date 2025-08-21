const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const { getStampUniqueness } = require('../utils/helpers');

async function handleVoiceChatRequest(req, res) {
    try {
        const { message, conversationHistory = [], sessionId } = req.body;

        console.log('🎤 Conversational voice chat request:', {
            message: message.substring(0, 50) + '...',
            historyLength: conversationHistory.length
        });

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        console.log('🔍 Checking stamp knowledge base for:', message);

        try {
            const stampResponse = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000'}/api/philaguide`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    conversationHistory: conversationHistory,
                    stream: true,
                    voiceChat: true,
                    sessionId: sessionId
                }),
            });

            if (stampResponse.ok) {
                const reader = stampResponse.body?.getReader();
                if (!reader) {
                    throw new Error('No response body');
                }

                let accumulatedContent = '';
                let structuredData = null;
                let foundStamps = 0;
                let rawStampData = [];
                let processedStampData = [];

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = new TextDecoder().decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));

                                if (data.type === 'content') {
                                    accumulatedContent += data.content;
                                } else if (data.type === 'structured_data') {
                                    structuredData = data.data;
                                    console.log('📊 Received processed structured data:', structuredData);
                                } else if (data.type === 'stamp_preview') {
                                    processedStampData = data.data.stamps || [];
                                    console.log('📋 Received processed stamp data from preview:', processedStampData);
                                    console.log('📋 Processed stamp data details:', processedStampData.map(s => ({
                                        name: s.name,
                                        country: s.country,
                                        year: s.year,
                                        denomination: s.denomination,
                                        color: s.color
                                    })));
                                } else if (data.type === 'raw_stamp_data') {
                                    rawStampData = data.data.stamps || [];
                                    console.log('📋 Received raw stamp data from function calls:', rawStampData);
                                    console.log('📋 Raw stamp data details:', rawStampData.map(s => ({
                                        id: s.id,
                                        stampId: s.stampId,
                                        name: s.name,
                                        country: s.country,
                                        issueDate: s.issueDate,
                                        issueYear: s.issueYear,
                                        denominationValue: s.denominationValue,
                                        denominationSymbol: s.denominationSymbol,
                                        color: s.color,
                                        stampImageUrl: s.stampImageUrl
                                    })));
                                } else if (data.type === 'complete') {
                                    break;
                                } else if (data.type === 'error') {
                                    throw new Error(data.error);
                                } else if (data.type === 'timeout') {
                                    console.log('⏰ Request timed out, falling back to general response');
                                    return null;
                                }
                            } catch (parseError) {
                                console.log('⚠️ Error parsing streaming data:', parseError);
                            }
                        }
                    }
                }

                console.log('🎴 Stamp search result:', {
                    hasStamps: rawStampData.length > 0 || structuredData !== null,
                    rawStampCount: rawStampData.length,
                    structuredData: !!structuredData
                });

                if (rawStampData.length > 0 || structuredData) {
                    console.log('✅ Found stamps in knowledge base - providing precise response');

                    let voiceResponse = '';
                    let stampDetails = null;

                    if (rawStampData.length > 0) {
                        const stamp = rawStampData[0];
                        console.log('🎴 Using raw stamp data:', stamp);

                        const name = stamp.name || stamp.Name || 'Unknown';
                        const country = stamp.country || stamp.Country || 'Unknown';
                        const issueDate = stamp.issueDate || stamp.IssueDate || 'Unknown';
                        const year = stamp.issueYear || stamp.IssueYear || (issueDate !== 'Unknown' ? issueDate.split('-')[0] : 'Unknown');
                        const denominationValue = stamp.denominationValue || stamp.DenominationValue || 'Unknown';
                        const denominationSymbol = stamp.denominationSymbol || stamp.DenominationSymbol || '';
                        const denomination = denominationSymbol ? `${denominationValue}${denominationSymbol}` : denominationValue;
                        const color = stamp.color || stamp.Color || 'Unknown';

                        let finalImageUrl = stamp.stampImageUrl || stamp.StampImageUrl || '/images/stamps/stamp.png';

                        const uniqueness = getStampUniqueness(stamp);
                        voiceResponse = `I found the ${name} stamp for you. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness}`;

                        stampDetails = {
                            type: 'single_stamp',
                            stamp: {
                                id: stamp.id || stamp.Id || stamp.stampId || 'unknown',
                                name: name,
                                country: country,
                                issueYear: year,
                                color: color,
                                denominationValue: denominationValue,
                                denominationSymbol: denominationSymbol,
                                fullDenomination: denomination,
                                image: finalImageUrl
                            },
                            imageUrl: finalImageUrl
                        };
                    } else if (structuredData) {
                        if (structuredData.type === 'card') {
                            const stamp = structuredData;
                            console.log('🎴 Using structured data from generateStampCard:', stamp);

                            const name = stamp.title || 'Unknown';
                            const subtitleParts = stamp.subtitle.split(' • ');
                            const country = subtitleParts[0] || 'Unknown';
                            const year = subtitleParts[1] || 'Unknown';
                            const denomination = subtitleParts[2] || 'Unknown';
                            const color = stamp.content?.[1]?.details?.find((d) => d.label === 'Color')?.value || 'Unknown';

                            let finalImageUrl = stamp.image;
                            if (finalImageUrl && finalImageUrl.includes('example.com')) {
                                finalImageUrl = '/images/stamps/stamp.png';
                            }

                            const uniqueness = getStampUniqueness(stamp);
                            voiceResponse = `I found the ${name} stamp for you. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness}`;

                            stampDetails = {
                                type: 'single_stamp',
                                stamp: {
                                    id: stamp.id || stamp.Id || stamp.stampId || 'unknown',
                                    name: name,
                                    country: country,
                                    issueYear: year,
                                    color: color,
                                    denominationValue: denomination,
                                    denominationSymbol: '',
                                    fullDenomination: denomination,
                                    image: finalImageUrl
                                },
                                imageUrl: finalImageUrl
                            };
                        } else if (structuredData.type === 'carousel') {
                            const stamps = structuredData.items || [];
                            console.log('🎠 Using carousel data with', stamps.length, 'stamps:', stamps);

                            if (stamps.length > 0) {
                                const stamp = stamps[0];
                                const name = stamp.title || 'Unknown';
                                const subtitleParts = stamp.subtitle.split(' • ');
                                const country = subtitleParts[0] || 'Unknown';
                                const year = subtitleParts[1] || 'Unknown';

                                let denomination = 'Unknown';
                                let color = 'Unknown';
                                let description = '';

                                if (stamp.content && stamp.content.length > 0) {
                                    const overviewSection = stamp.content.find((s) => s.section === 'Overview');
                                    if (overviewSection && overviewSection.text) {
                                        description = overviewSection.text;
                                    }

                                    const detailsSection = stamp.content.find((s) => s.section === 'Details');
                                    if (detailsSection && detailsSection.details) {
                                        const colorDetail = detailsSection.details.find((d) => d.label === 'Color');
                                        if (colorDetail) {
                                            color = colorDetail.value;
                                        }
                                    }
                                }

                                if (!description) {
                                    const summaryParts = stamp.summary?.split(' ') || [];
                                    denomination = summaryParts[0] || 'Unknown';
                                    color = summaryParts[1] || 'Unknown';
                                }

                                let finalImageUrl = stamp.image;
                                if (finalImageUrl && finalImageUrl.includes('example.com')) {
                                    finalImageUrl = '/images/stamps/stamp.png';
                                }

                                const uniqueness = getStampUniqueness(stamp);
                                if (stamps.length === 1) {
                                    if (description) {
                                        voiceResponse = `I found the ${name} stamp for you. ${description} ${stamp.significance || uniqueness}`;
                                    } else {
                                        voiceResponse = `I found the ${name} stamp for you. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness}`;
                                    }
                                } else {
                                    if (description) {
                                        voiceResponse = `I found ${stamps.length} stamps for you. Let me tell you about the ${name} stamp. ${description} ${stamp.significance || uniqueness} Would you like me to tell you about the others?`;
                                    } else {
                                        voiceResponse = `I found ${stamps.length} stamps for you. Let me tell you about the ${name} stamp. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness} Would you like me to tell you about the others?`;
                                    }
                                }

                                stampDetails = {
                                    type: 'single_stamp',
                                    stamp: {
                                        id: stamp.id || stamp.Id || stamp.stampId || 'unknown',
                                        name: name,
                                        country: country,
                                        issueYear: year,
                                        color: color,
                                        denominationValue: denomination,
                                        denominationSymbol: '',
                                        fullDenomination: denomination,
                                        image: finalImageUrl
                                    },
                                    imageUrl: finalImageUrl
                                };
                            }
                        }
                    }

                    return res.json({
                        response: voiceResponse,
                        conversationLength: conversationHistory.length + 2,
                        source: 'stamp_knowledge_base',
                        stampDetails: stampDetails,
                        hasStamps: true
                    });
                }
            }
        } catch (error) {
            console.log('⚠️ Stamp knowledge base check failed, falling back to general response:', error);
        }

        console.log('🌐 No stamps found - providing general conversational response');

        const messages = [
            {
                role: "system",
                content: `You are a knowledgeable stamp collecting expert having a natural, friendly conversation. 

IMPORTANT CONVERSATIONAL GUIDELINES:
- Keep responses SHORT and CONCISE - like a real conversation, not a lecture
- Respond naturally and conversationally, like talking to a friend
- Be enthusiastic but brief - 2-3 sentences maximum
- Ask one simple follow-up question to keep the conversation flowing
- Use natural language for denominations (e.g., "one-third penny" instead of "1/3d")
- Vary your responses - don't use repetitive patterns
- Show genuine interest but keep it brief
- If the user asks about stamps you don't have specific information about, provide general philatelic knowledge

Example conversational styles:
- "The Trout Blue is a beautiful stamp from New Zealand, 1935. Love that blue color! Do you collect many stamps from that era?"
- "That's a great choice! The Trout Blue was part of New Zealand's pictorial series. What draws you to this stamp?"
- "The Trout Blue stamp is stunning - one of New Zealand's finest from 1935. Are you interested in other stamps from that period?"
- "I don't have specific details about that stamp, but I'd love to help you learn more about philately in general. What interests you most about stamp collecting?"

Keep it short, natural, and conversational!`
            },
            ...conversationHistory,
            {
                role: "user",
                content: message
            }
        ];

        const completion = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages,
            max_tokens: 150,
            temperature: 0.8
        });

        const response = completion.choices[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat it?";

        console.log('🎤 General conversational response:', response);

        return res.json({
            response,
            conversationLength: conversationHistory.length + 2,
            source: 'general_knowledge',
            hasStamps: false
        });

    } catch (error) {
        console.error('❌ Voice chat API error:', error);
        return res.status(500).json({
            error: 'Sorry, I\'m having trouble with our conversation right now. Could you try again?'
        });
    }
}

function getVoiceChatTest(req, res) {
    return res.json({ message: 'Voice chat API is working!' });
}

module.exports = {
    handleVoiceChatRequest,
    getVoiceChatTest,
};
