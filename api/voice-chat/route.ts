import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

// Test endpoint
export async function GET() {
    return NextResponse.json({ message: 'Voice chat API is working!' })
}

// Conversational voice chat endpoint
export async function POST(request: NextRequest) {
    try {
        const { message, conversationHistory = [], sessionId } = await request.json()

        console.log('🎤 Conversational voice chat request:', {
            message: message.substring(0, 50) + '...',
            historyLength: conversationHistory.length
        })

        if (!message) {
            return NextResponse.json({ error: 'Message is required' }, { status: 400 })
        }

        // Step 1: First check if this query can be answered from the stamp knowledge base
        console.log('🔍 Checking stamp knowledge base for:', message)

        try {
            const stampResponse = await fetch(`http://localhost:3000/api/philaguide`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    conversationHistory: conversationHistory,
                    stream: true, // Use streaming to get accurate function call data
                    voiceChat: true, // Use voice chat mode to maintain conversation context
                    sessionId: sessionId // Use the session ID passed from frontend
                }),
            })

            if (stampResponse.ok) {
                // Handle streaming response to get accurate stamp data
                const reader = stampResponse.body?.getReader()
                if (!reader) {
                    throw new Error('No response body')
                }

                let accumulatedContent = ''
                let structuredData: any = null
                let foundStamps: number = 0
                let rawStampData: any[] = [] // Store the raw stamp data from function calls
                let processedStampData: any[] = [] // Store the processed stamp data from preview

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    const chunk = new TextDecoder().decode(value)
                    const lines = chunk.split('\n')

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6))

                                if (data.type === 'content') {
                                    accumulatedContent += data.content
                                } else if (data.type === 'structured_data') {
                                    // This is the processed structured data from generateStampCard
                                    structuredData = data.data
                                    console.log('📊 Received processed structured data:', structuredData)
                                } else if (data.type === 'stamp_preview') {
                                    // This is the processed stamp data from preview
                                    processedStampData = data.data.stamps || []
                                    console.log('📋 Received processed stamp data from preview:', processedStampData)
                                    console.log('📋 Processed stamp data details:', processedStampData.map(s => ({
                                        name: s.name,
                                        country: s.country,
                                        year: s.year,
                                        denomination: s.denomination,
                                        color: s.color
                                    })))
                                } else if (data.type === 'raw_stamp_data') {
                                    // This is the raw stamp data from function calls (most accurate)
                                    rawStampData = data.data.stamps || []
                                    console.log('📋 Received raw stamp data from function calls:', rawStampData)
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
                                    })))
                                } else if (data.type === 'complete') {
                                    // Streaming complete
                                    break
                                } else if (data.type === 'error') {
                                    throw new Error(data.error)
                                } else if (data.type === 'timeout') {
                                    console.log('⏰ Request timed out, falling back to general response')
                                    return null // Return null to trigger fallback
                                }
                            } catch (parseError) {
                                console.log('⚠️ Error parsing streaming data:', parseError)
                            }
                        }
                    }
                }

                console.log('🎴 Stamp search result:', {
                    hasStamps: rawStampData.length > 0 || structuredData !== null,
                    rawStampCount: rawStampData.length,
                    structuredData: !!structuredData
                })

                // If we found stamps in the knowledge base, provide precise response with details
                if (rawStampData.length > 0 || structuredData) {
                    console.log('✅ Found stamps in knowledge base - providing precise response')

                    let voiceResponse = ''
                    let stampDetails = null

                    // Use raw stamp data if available, otherwise use structured data
                    if (rawStampData.length > 0) {
                        // Use the raw stamp data from function calls (most accurate)
                        const stamp = rawStampData[0]
                        console.log('🎴 Using raw stamp data:', stamp)

                        // Extract data from raw stamp object using the correct field names (prioritize lowercase, fallback to uppercase)
                        const name = stamp.name || stamp.Name || 'Unknown'
                        const country = stamp.country || stamp.Country || 'Unknown'
                        const issueDate = stamp.issueDate || stamp.IssueDate || 'Unknown'
                        const year = stamp.issueYear || stamp.IssueYear || (issueDate !== 'Unknown' ? issueDate.split('-')[0] : 'Unknown')
                        const denominationValue = stamp.denominationValue || stamp.DenominationValue || 'Unknown'
                        const denominationSymbol = stamp.denominationSymbol || stamp.DenominationSymbol || ''
                        const denomination = denominationSymbol ? `${denominationValue}${denominationSymbol}` : denominationValue
                        const color = stamp.color || stamp.Color || 'Unknown'

                        // Use the actual image URL from the knowledge base
                        let finalImageUrl = stamp.stampImageUrl || stamp.StampImageUrl || '/images/stamps/stamp.png'

                        // Create natural conversational response with stamp details and uniqueness
                        const uniqueness = getStampUniqueness(stamp)
                        voiceResponse = `I found the ${name} stamp for you. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness}`

                        stampDetails = {
                            type: 'single_stamp',
                            stamp: {
                                id: stamp.id || stamp.Id || stamp.stampId || 'unknown', // Add stamp ID for View Details
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
                        }
                    } else if (structuredData) {
                        // Fallback to structured data if raw data not available
                        if (structuredData.type === 'card') {
                            // Single stamp found - use the structured data from generateStampCard
                            const stamp = structuredData
                            console.log('🎴 Using structured data from generateStampCard:', stamp)

                            // Extract data from the structured data (this should be accurate)
                            const name = stamp.title || 'Unknown'
                            const subtitleParts = stamp.subtitle.split(' • ')
                            const country = subtitleParts[0] || 'Unknown'
                            const year = subtitleParts[1] || 'Unknown'
                            const denomination = subtitleParts[2] || 'Unknown'
                            const color = stamp.content?.[1]?.details?.find((d: any) => d.label === 'Color')?.value || 'Unknown'

                            // Use the actual image URL from the knowledge base
                            let finalImageUrl = stamp.image
                            if (finalImageUrl && finalImageUrl.includes('example.com')) {
                                finalImageUrl = '/images/stamps/stamp.png' // Use a real stamp image as fallback
                            }

                            // Create natural conversational response with stamp details and uniqueness
                            const uniqueness = getStampUniqueness(stamp)
                            voiceResponse = `I found the ${name} stamp for you. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness}`

                            stampDetails = {
                                type: 'single_stamp',
                                stamp: {
                                    id: stamp.id || stamp.Id || stamp.stampId || 'unknown', // Add stamp ID for View Details
                                    name: name,
                                    country: country,
                                    issueYear: year,
                                    color: color,
                                    denominationValue: denomination,
                                    denominationSymbol: '',
                                    fullDenomination: denomination,
                                    image: finalImageUrl
                                },
                                imageUrl: finalImageUrl // Use the actual image URL from knowledge base
                            }
                        } else if (structuredData.type === 'carousel') {
                            // Multiple stamps found - use the first stamp from the carousel
                            const stamps = structuredData.items || []
                            console.log('🎠 Using carousel data with', stamps.length, 'stamps:', stamps)

                            if (stamps.length > 0) {
                                const stamp = stamps[0] // Use the first stamp
                                const name = stamp.title || 'Unknown'
                                const subtitleParts = stamp.subtitle.split(' • ')
                                const country = subtitleParts[0] || 'Unknown'
                                const year = subtitleParts[1] || 'Unknown'

                                // Try to use new detailed content structure first
                                let denomination = 'Unknown'
                                let color = 'Unknown'
                                let description = ''

                                if (stamp.content && stamp.content.length > 0) {
                                    const overviewSection = stamp.content.find((s: any) => s.section === 'Overview')
                                    if (overviewSection && overviewSection.text) {
                                        description = overviewSection.text
                                    }

                                    const detailsSection = stamp.content.find((s: any) => s.section === 'Details')
                                    if (detailsSection && detailsSection.details) {
                                        const colorDetail = detailsSection.details.find((d: any) => d.label === 'Color')
                                        if (colorDetail) {
                                            color = colorDetail.value
                                        }
                                    }
                                }

                                // Fall back to old format if new structure not available
                                if (!description) {
                                    const summaryParts = stamp.summary?.split(' ') || []
                                    denomination = summaryParts[0] || 'Unknown'
                                    color = summaryParts[1] || 'Unknown'
                                }

                                // Use the actual image URL from the knowledge base
                                let finalImageUrl = stamp.image
                                if (finalImageUrl && finalImageUrl.includes('example.com')) {
                                    finalImageUrl = '/images/stamps/stamp.png' // Use a real stamp image as fallback
                                }

                                // Create natural conversational response for multiple stamps
                                const uniqueness = getStampUniqueness(stamp)
                                if (stamps.length === 1) {
                                    if (description) {
                                        voiceResponse = `I found the ${name} stamp for you. ${description} ${stamp.significance || uniqueness}`
                                    } else {
                                        voiceResponse = `I found the ${name} stamp for you. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness}`
                                    }
                                } else {
                                    if (description) {
                                        voiceResponse = `I found ${stamps.length} stamps for you. Let me tell you about the ${name} stamp. ${description} ${stamp.significance || uniqueness} Would you like me to tell you about the others?`
                                    } else {
                                        voiceResponse = `I found ${stamps.length} stamps for you. Let me tell you about the ${name} stamp. This is a ${denomination} stamp from ${country}, issued in ${year}. ${uniqueness} Would you like me to tell you about the others?`
                                    }
                                }

                                stampDetails = {
                                    type: 'single_stamp',
                                    stamp: {
                                        id: stamp.id || stamp.Id || stamp.stampId || 'unknown', // Add stamp ID for View Details
                                        name: name,
                                        country: country,
                                        issueYear: year,
                                        color: color,
                                        denominationValue: denomination,
                                        denominationSymbol: '',
                                        fullDenomination: denomination,
                                        image: finalImageUrl
                                    },
                                    imageUrl: finalImageUrl // Use the actual image URL from knowledge base
                                }
                            }
                        }
                    }

                    return NextResponse.json({
                        response: voiceResponse,
                        conversationLength: conversationHistory.length + 2,
                        source: 'stamp_knowledge_base',
                        stampDetails: stampDetails,
                        hasStamps: true
                    })
                }
            }
        } catch (error) {
            console.log('⚠️ Stamp knowledge base check failed, falling back to general response:', error)
        }

        // Step 2: If no stamps found or error occurred, provide general conversational response
        console.log('🌐 No stamps found - providing general conversational response')

        // Build conversation context for general response
        const messages = [
            {
                role: "system" as const,
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
                role: "user" as const,
                content: message
            }
        ]

        const completion = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages,
            max_tokens: 150, // Much shorter responses
            temperature: 0.8
        })

        const response = completion.choices[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat it?"

        console.log('🎤 General conversational response:', response)

        return NextResponse.json({
            response,
            conversationLength: conversationHistory.length + 2,
            source: 'general_knowledge',
            hasStamps: false
        })

    } catch (error) {
        console.error('❌ Voice chat API error:', error)
        return NextResponse.json({
            error: 'Sorry, I\'m having trouble with our conversation right now. Could you try again?'
        }, { status: 500 })
    }
}

// Function to generate unique stamp descriptions
function getStampUniqueness(stamp: any): string {
    const name = stamp.Name || stamp.title || 'Unknown'
    const country = stamp.Country || 'Unknown'
    const year = stamp.IssueYear || stamp.year || 'Unknown'
    const color = stamp.Color || 'Unknown'
    const seriesName = stamp.SeriesName || ''
    const paperType = stamp.PaperType || ''

    // Create unique descriptions based on stamp characteristics
    if (year === '1840' && country === 'United Kingdom') {
        return "This is the world's first adhesive postage stamp, making it incredibly significant in philatelic history."
    }

    if (year === '1935' && name.includes('Trout')) {
        return "This stamp is part of New Zealand's iconic pictorial series, featuring beautiful native wildlife."
    }

    if (seriesName && seriesName.includes('Pictorial')) {
        return `This stamp is part of the ${seriesName}, which showcases the country's natural beauty and cultural heritage.`
    }

    if (color === 'Blue' && year === '1935') {
        return "This blue stamp from the 1930s represents a classic era in New Zealand philately."
    }

    if (paperType && paperType.includes('Chalk')) {
        return "This stamp uses chalk-surfaced paper, which gives it a distinctive texture and appearance."
    }

    // Default unique descriptions
    const defaultDescriptions = [
        "This stamp captures a fascinating moment in postal history.",
        "It's a beautiful example of the artistry and craftsmanship of stamp design.",
        "This stamp tells an interesting story about the era it was issued in.",
        "It's a wonderful piece of philatelic history that collectors treasure.",
        "This stamp represents the cultural and historical significance of its time."
    ]

    return defaultDescriptions[Math.floor(Math.random() * defaultDescriptions.length)]
}