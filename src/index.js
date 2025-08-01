const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const multer = require('multer');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8080;

const upload = multer(); // Initialize multer for handling file uploads

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for image uploads

// Vercel configuration (these are Next.js specific, not directly applicable but kept for reference)
// export const maxDuration = 15 // 15 seconds for Vercel hobby plan (allows for function calls)
// export const dynamic = 'force-dynamic'

console.log('OPENAI_API_KEY (backend): ', process.env.OPENAI_API_KEY);
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const ASSISTANT_ID = 'asst_AfsiDbpnx2WjgZV7O97eHhyb';

// Add timeout configuration
const TIMEOUT_MS = 12000; // 12 seconds to allow for function calls while staying under Vercel's limit

// Timeout helper function
function createTimeoutPromise(ms) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), ms);
    });
}

// Streaming response handler
async function handleStreamingResponse(message, history, res) {
    const encoder = new TextEncoder(); // TextEncoder is available in Node.js

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        console.log('🔄 Starting streaming response for:', message);

        // Step 1: Create a thread
        const thread = await openai.beta.threads.create();
        console.log('✅ Thread created:', thread.id);

        // Step 2: Add the user's message to the thread
        await openai.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: message,
        });
        console.log('✅ Message added to thread');

        // Step 3: Create run with the assistant
        const run = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: ASSISTANT_ID,
        });
        console.log('✅ Run created:', run.id);

        // Step 4: Stream the response
        await streamRunResponse(thread.id, run.id, res, encoder);

        res.end();

    } catch (error) {
        console.error('❌ Streaming error:', error);
        const errorMessage = `data: ${JSON.stringify({ error: 'Failed to process request' })}\n\n`;
        res.write(encoder.encode(errorMessage));
        res.end();
    }
}

// Stream run response
async function streamRunResponse(threadId, runId, res, encoder) {
    let runStatus = 'queued';
    let attempts = 0;
    const maxAttempts = 15; // 15 seconds max to allow for function calls

    while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
        console.log(`⏳ Run status: ${runStatus} (attempt ${attempts + 1}/${maxAttempts})`);

        // Send status update
        const statusMessage = `data: ${JSON.stringify({ type: 'status', status: runStatus })}\n\n`;
        res.write(encoder.encode(statusMessage));

        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
            const runResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });
            runStatus = runResult.status;
            attempts++;

            if (runResult.last_error) {
                console.error('❌ Run error:', runResult.last_error);
                const errorMessage = `data: ${JSON.stringify({ type: 'error', error: runResult.last_error })}\n\n`;
                res.write(encoder.encode(errorMessage));
                return;
            }
        } catch (error) {
            console.error('❌ Error checking run status:', error);
            break;
        }
    }

    console.log(`✅ Run completed with status: ${runStatus}`);

    // Handle different run statuses
    if (runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'expired') {
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: `Run ${runStatus}` })}\n\n`;
        res.write(encoder.encode(errorMessage));
        return;
    }

    if (runStatus === 'queued' || runStatus === 'in_progress') {
        const timeoutMessage = `data: ${JSON.stringify({ type: 'timeout', message: 'Processing is taking longer than expected. Please try a more specific query about stamps, or ask about a particular country or year.' })}\n\n`;
        res.write(encoder.encode(timeoutMessage));
        return;
    }

    // Handle requires_action (function calls)
    if (runStatus === 'requires_action') {
        console.log('🔧 Run requires action - handling function calls...');

        const runResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });
        console.log('📊 Run result:', runResult);

        if (runResult.required_action && runResult.required_action.type === 'submit_tool_outputs') {
            console.log('🔧 Found tool outputs to submit');

            const toolCalls = runResult.required_action.submit_tool_outputs.tool_calls;
            console.log('🔧 Tool calls found:', toolCalls.length);

            const toolOutputs = [];
            let stamps = [];
            let structuredData = null;

            for (const toolCall of toolCalls) {
                console.log('🔧 Processing tool call:', toolCall);
                if (toolCall.function.name === 'return_stamp_data') {
                    try {
                        const functionArgs = JSON.parse(toolCall.function.arguments);
                        console.log('📊 Function call data:', functionArgs);

                        if (functionArgs.stamps && Array.isArray(functionArgs.stamps)) {
                            stamps = functionArgs.stamps;
                            structuredData = functionArgs;
                            console.log(`✅ Found ${stamps.length} stamps from function call`);
                            console.log('📋 Stamp details:', stamps.map(s => ({ name: s.Name, country: s.Country, year: s.IssueYear })));

                            // Send stamp preview immediately
                            const stampPreview = {
                                count: stamps.length,
                                stamps: stamps.slice(0, 5).map(s => ({
                                    name: s.Name || 'Unknown',
                                    country: s.Country || 'Unknown',
                                    year: s.IssueYear || 'Unknown',
                                    denomination: `${s.DenominationValue || ''}${s.DenominationSymbol || ''}`,
                                    color: s.Color || 'Unknown',
                                })),
                            };

                            const previewMessage = `data: ${JSON.stringify({ type: 'stamp_preview', data: stampPreview })}\n\n`;
                            res.write(encoder.encode(previewMessage));
                        } else {
                            console.log('⚠️ No stamps array found in function call data');
                        }
                    } catch (error) {
                        console.log('❌ Error parsing function arguments:', error);
                    }
                }

                toolOutputs.push({
                    tool_call_id: toolCall.id,
                    output: JSON.stringify({ success: true, stamps: stamps }),
                });
            }

            // Create structured data immediately from function call
            let immediateStructuredData = null;
            if (stamps.length === 1) {
                console.log('🎴 Creating single stamp card with data:', stamps[0]);
                immediateStructuredData = generateStampCard(stamps[0]);
                console.log('🎴 Generated card data:', immediateStructuredData);
            } else if (stamps.length > 1) {
                console.log(`🎠 Creating carousel with ${stamps.length} stamps`);
                immediateStructuredData = generateStampCarousel(stamps.slice(0, 5));
                console.log('🎠 Generated carousel data:', immediateStructuredData);
            } else {
                console.log('⚠️ No stamps found in function call data');
            }

            // Stream the immediate response
            let responseText = '';
            if (stamps.length > 0) {
                responseText = `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`;
            } else {
                responseText = "I couldn't find any specific stamps matching your query. Let me provide some general information about philately instead.";
            }

            // Stream the response text
            const words = responseText.split(' ');
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                const message = `data: ${JSON.stringify({ type: 'content', content: word + (i < words.length - 1 ? ' ' : '') })}` + '\n\n';
                res.write(encoder.encode(message));
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Send structured data
            if (immediateStructuredData) {
                const structuredMessage = `data: ${JSON.stringify({ type: 'structured_data', data: immediateStructuredData })}\n\n`;
                res.write(encoder.encode(structuredMessage));
            }

            // Send completion signal
            const completeMessage = `data: ${JSON.stringify({ type: 'complete' })}\n\n`;
            res.write(encoder.encode(completeMessage));

            return;
        }
    }

    // Get the messages and stream the response
    if (runStatus === 'completed') {
        await streamMessages(threadId, res, encoder);
    }
}

// Stream messages from thread
async function streamMessages(threadId, res, encoder) {
    try {
        const messages = await openai.beta.threads.messages.list(threadId);
        const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');

        if (assistantMessages.length > 0) {
            const latestMessage = assistantMessages[0];

            if (latestMessage.content.length > 0) {
                const content = latestMessage.content[0];

                if (content.type === 'text') {
                    const text = content.text.value;
                    const cleanedText = cleanResponseText(text);

                    // Stream the text character by character for ChatGPT-like effect
                    const words = cleanedText.split(' ');
                    for (let i = 0; i < words.length; i++) {
                        const word = words[i];
                        const message = `data: ${JSON.stringify({ type: 'content', content: word + (i < words.length - 1 ? ' ' : '') })}` + '\n\n';
                        res.write(encoder.encode(message));

                        // Small delay for streaming effect
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }

                    // Send completion signal
                    const completeMessage = `data: ${JSON.stringify({ type: 'complete' })}\n\n`;
                    res.write(encoder.encode(completeMessage));
                }
            }
        }
    } catch (error) {
        console.error('❌ Error streaming messages:', error);
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to get response' })}\n\n`;
        res.write(encoder.encode(errorMessage));
    }
}

// Generate card format for single stamp
function generateStampCard(stamp) {
    // Map the vector store fields to card display format
    const year = stamp.IssueYear || (stamp.IssueDate ? stamp.IssueDate.split('-')[0] : 'Unknown');
    const denomination = `${stamp.DenominationValue}${stamp.DenominationSymbol}`;
    const subtitle = `${stamp.Country} • ${year} • ${denomination}`;

    // Handle different possible image URL field names
    const imageUrl = stamp.StampImageUrl || stamp.image || stamp.StampImage || '/images/stamps/no-image-available.png';

    return {
        type: 'card',
        id: stamp.Id || stamp.id,
        title: stamp.Name || stamp.StampCatalogCode || 'Stamp',
        subtitle: subtitle,
        image: imageUrl,
        content: [
            {
                section: 'Overview',
                text: `${stamp.Name} from ${stamp.Country}, issued in ${year}. Denomination: ${denomination}. Color: ${stamp.Color || 'Unknown'}.`,
            },
            {
                section: 'Details',
                details: [
                    { label: 'Catalog Code', value: stamp.StampCatalogCode || 'N/A' },
                    { label: 'Issue Date', value: stamp.IssueDate || 'N/A' },
                    { label: 'Color', value: stamp.Color || 'N/A' },
                    { label: 'Paper Type', value: stamp.PaperType || 'N/A' },
                ],
            },
        ],
        significance: `A ${stamp.Color || 'colorful'} stamp from ${stamp.Country} issued in ${year}.`,
        specialNotes: stamp.SeriesName ? `Part of the ${stamp.SeriesName} series.` : '',
    };
}

// Generate carousel format for multiple stamps
function generateStampCarousel(stamps) {
    return {
        type: 'carousel',
        title: `Found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''}`,
        items: stamps.map(stamp => {
            const year = stamp.IssueYear || (stamp.IssueDate ? stamp.IssueDate.split('-')[0] : 'Unknown');
            const denomination = `${stamp.DenominationValue}${stamp.DenominationSymbol}`;

            // Handle different possible image URL field names
            const imageUrl = stamp.StampImageUrl || stamp.image || stamp.StampImage || '/images/stamps/no-image-available.png';

            return {
                id: stamp.Id || stamp.id,
                title: stamp.Name || stamp.StampCatalogCode || 'Stamp',
                subtitle: `${stamp.Country} • ${year}`,
                image: imageUrl,
                summary: `${denomination} ${stamp.Color || 'Unknown'}`,
                marketValue: 'Value varies by condition',
                quickFacts: [
                    `${stamp.Country} ${year}`,
                    stamp.Color || 'Unknown',
                    denomination,
                ],
            };
        }),
    };
}

// Clean response text to remove technical references
function cleanResponseText(text) {
    // Remove technical references
    let cleaned = text
        .replace(/download\.json/g, 'stamp database')
        .replace(/vector store/g, 'stamp collection')
        .replace(/file_search/g, 'search')
        .replace(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^ \\)\\]]+/g, '')
        .replace(/ref as [^ ]+/g, '')
        .replace(/catalog number [A-Z0-9]+/gi, '')
        .replace(/Campbell Paterson Catalogue/g, 'stamp catalog')
        .replace(/catalog number/g, 'catalog');

    // Remove markdown syntax and raw data
    cleaned = cleaned
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // Remove markdown image syntax
        .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold markdown
        .replace(/`([^`]+)`/g, '$1') // Remove code markdown
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // Remove link markdown
        .replace(/\{[\s\S]*?\}/g, '') // Remove JSON objects
        .replace(/```[\s\S]*?```/g, ''); // Remove code blocks

    // Remove any remaining technical jargon
    cleaned = cleaned
        .replace(/technical details[^.]*\./g, '')
        .replace(/file reference[^.]*\./g, '')
        .replace(/database entry[^.]*\./g, '')
        .replace(/raw data[^.]*\./g, '')
        .replace(/function call[^.]*\./g, '');

    // Clean up extra spaces and punctuation
    cleaned = cleaned
        .replace(/\s+/g, ' ')
        .replace(/\s+\./g, '.')
        .replace(/\s+,/g, ',')
        .replace(/\s+-/g, ' - ')
        .trim();

    return cleaned;
}

// Parse response for stamp data (from philaguide)
function parseResponse(response) {
    try {
        console.log('Parsing response:', response.substring(0, 200) + '...');

        // Try to extract JSON from the response - look for JSON blocks
        const jsonMatch = response.match(/```json\\s*(\\{[\\s\\S]*?\\})\\s*```/);
        if (jsonMatch) {
            console.log('Found JSON block in response');
            const jsonData = JSON.parse(jsonMatch[1]);

            if (jsonData.stamps && Array.isArray(jsonData.stamps)) {
                console.log('Successfully parsed stamps from JSON block');
                return {
                    stamps: jsonData.stamps,
                    structuredData: jsonData,
                };
            }
        }

        // Try to extract JSON without code blocks
        const jsonMatch2 = response.match(/\\{[\\s\\S]*\\}/);
        if (jsonMatch2) {
            console.log('Found JSON in response (no code blocks)');
            const jsonData = JSON.parse(jsonMatch2[0]);

            if (jsonData.stamps && Array.isArray(jsonData.stamps)) {
                console.log('Successfully parsed stamps from JSON');
                return {
                    stamps: jsonData.stamps,
                    structuredData: jsonData,
                };
            }
        }

        // Check if response contains real image URLs but no JSON structure
        if (response.includes('3pmplatformstorage.blob.core.windows.net')) {
            console.log('Response contains real image URLs but no JSON structure');
            // Try to extract stamp information from text
            const stampInfo = extractStampInfoFromText(response);
            if (stampInfo) {
                return {
                    stamps: [stampInfo],
                    structuredData: { stamps: [stampInfo] },
                };
            }
        }

        // New: Try to extract stamp data from conversational responses
        const extractedStamps = extractStampsFromConversation(response);
        if (extractedStamps.length > 0) {
            console.log('Successfully extracted stamps from conversational response');
            return {
                stamps: extractedStamps,
                structuredData: { stamps: extractedStamps },
            };
        }

        console.log('No valid JSON or stamp data found in response');
        return { stamps: [] };
    } catch (error) {
        console.log('❌ Failed to parse response:', error);
        return { stamps: [] };
    }
}

// Extract stamp information from conversational text
function extractStampsFromConversation(text) {
    const stamps = [];

    // Look for patterns like "Trout Blue 1/3d" stamp from New Zealand
    const stampPatterns = [
        /"([^"]+)"\\s+stamp\\s+from\\s+([^,]+)/gi,
        /([^"``]+)\\s+stamp\\s+from\\s+([^,]+)/gi,
        /([^"``]+)\\s+from\\s+([^,]+)/gi,
    ];

    for (const pattern of stampPatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            const stampName = match[1]?.trim();
            const country = match[2]?.trim();

            if (stampName && country) {
                // Look for additional details in the text
                const yearMatch = text.match(/(\\d{4})/);
                const year = yearMatch ? yearMatch[1] : 'Unknown';

                const denominationMatch = text.match(/(\\d+[\\/\\d]*\\s*[a-z]+)/i);
                const denomination = denominationMatch ? denominationMatch[1] : 'Unknown';

                const colorMatch = text.match(/(blue|red|green|yellow|brown|grey|gray|black|white|orange|purple|pink)/i);
                const color = colorMatch ? colorMatch[1] : 'Unknown';

                // Look for image URL
                const imageUrlMatch = text.match(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^ \\)\\]]+/);
                const imageUrl = imageUrlMatch ? imageUrlMatch[0] : '/images/stamps/no-image-available.png';

                stamps.push({
                    Id: `extracted-${Date.now()}-${stamps.length}`,
                    Name: stampName,
                    Country: country,
                    IssueYear: year,
                    DenominationValue: denomination.includes('/') ? 1 : parseFloat(denomination.match(/\\d+/)?.[0] || '1'),
                    DenominationSymbol: denomination.includes('d') ? 'd' : denomination.includes('c') ? 'c' : '',
                    StampImageUrl: imageUrl,
                    Color: color,
                    SeriesName: 'Extracted from response',
                    IssueDate: year !== 'Unknown' ? `${year}-01-01` : null,
                    PaperType: 'Unknown',
                    CatalogNumber: 'N/A',
                });
            }
        }
    }

    return stamps;
}

// Extract stamp information from text when JSON parsing fails
function extractStampInfoFromText(text) {
    try {
        // Look for image URLs in the text
        const imageUrlMatch = text.match(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^ \\)\\]]+/);
        if (imageUrlMatch) {
            const imageUrl = imageUrlMatch[0];

            // Try to extract basic stamp info from the text
            const nameMatch = text.match(/\*\*([^*]+)\*\*/);
            const countryMatch = text.match(/Country[: ]+([^\\n]+)/i);
            const yearMatch = text.match(/Year[: ]+([^\\n]+)/i) || text.match(/(\\d{4})/);
            const denominationMatch = text.match(/Denomination[: ]+([^\\n]+)/i);

            return {
                id: `extracted-${Date.now()}`,
                name: nameMatch ? nameMatch[1].trim() : 'Stamp',
                country: countryMatch ? countryMatch[1].trim() : 'Unknown',
                year: yearMatch ? yearMatch[1].trim() : 'Unknown',
                denomination: denominationMatch ? denominationMatch[1].trim() : 'Unknown',
                image: imageUrl,
                description: text.substring(0, 200) + '...',
                marketValue: 'Unknown',
                rarity: 'Unknown',
            };
        }

        return null;
    } catch (error) {
        console.log('Failed to extract stamp info from text:', error);
        return null;
    }
}

app.get('/', (req, res) => {
  res.send('Node.js Backend is running!');
});

app.post('/api/philaguide', async (req, res) => {
    try {
        const { message, history = [], stream = false } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Check if streaming is requested
        if (stream) {
            return handleStreamingResponse(message, history, res);
        }

        // Fallback for non-streaming requests (voice chat, etc.)
        console.log('Using non-streaming mode for:', message);

        // Use OpenAI Assistant with file-based knowledge
        console.log('Using OpenAI Assistant for:', message);

        // Call the assistant API with timeout
        let assistantResult;
        try {
            // Create a timeout promise
            const timeoutPromise = createTimeoutPromise(TIMEOUT_MS);

            // Create the assistant call promise
            const assistantPromise = (async () => {
                // Step 1: First fetch the assistant (like in Flutter)
                const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
                console.log('✅ Assistant fetched:', assistant.id);

                // Step 2: Create a new thread
                console.log('🔄 Creating new thread...');
                const thread = await openai.beta.threads.create();
                console.log('✅ Thread created:', thread);
                console.log('✅ Thread ID:', thread.id);
                console.log('✅ Thread object keys:', Object.keys(thread));

                if (!thread.id) {
                    console.error('❌ Thread creation failed - no ID returned');
                    console.error('❌ Thread object:', JSON.stringify(thread, null, 2));
                    throw new Error('Failed to create thread - no thread ID returned');
                }

                // Step 3: Add the user's message to the thread
                const threadMessage = await openai.beta.threads.messages.create(thread.id, {
                    role: 'user',
                    content: message,
                });
                console.log('✅ Message created:', threadMessage.id);

                // Step 4: Create run with the assistant
                const run = await openai.beta.threads.runs.create(thread.id, {
                    assistant_id: assistant.id,
                });
                console.log('✅ Run created:', run.id);

                if (!run.id) {
                    throw new Error('Failed to create run - no run ID returned');
                }

                // Wait for run to complete with proper status checking
                console.log('⏳ Waiting for run to complete...');
                let runStatus = run.status;
                let attempts = 0;
                const maxAttempts = 4; // 4 seconds max wait (4 attempts × 1 second)

                while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
                    console.log(`⏳ Run status: ${runStatus} (attempt ${attempts + 1}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Reduced to 1 second

                    try {
                        const runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: thread.id });
                        runStatus = runResult.status;
                        attempts++;

                        // Log any errors
                        if (runResult.last_error) {
                            console.error('❌ Run error:', runResult.last_error);
                        }
                    } catch (error) {
                        console.error('❌ Error checking run status:', error);
                        break;
                    }
                }

                console.log(`✅ Run completed with status: ${runStatus}`);

                // Check if run failed
                if (runStatus === 'failed') {
                    console.error('❌ Run failed');
                    throw new Error('Assistant run failed');
                }

                if (runStatus === 'cancelled') {
                    console.error('❌ Run cancelled');
                    throw new Error('Assistant run cancelled');
                }

                if (runStatus === 'expired') {
                    console.error('❌ Run expired');
                    throw new Error('Assistant run expired');
                }

                // If still in progress after timeout, return a quick response
                if (runStatus === 'queued' || runStatus === 'in_progress') {
                    console.log('⏰ Run still in progress after timeout, returning quick response');
                    return {
                        response: "I'm processing your request about stamps. This might take a moment. Please try again with a more specific query or check back in a few seconds.",
                        stampsFound: 0,
                        hasStructuredData: false,
                        stamps: [],
                        structuredData: null,
                    };
                }

                // Handle requires_action (function calls)
                if (runStatus === 'requires_action') {
                    console.log('🔧 Run requires action - handling function calls...');

                    const runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: thread.id });
                    console.log('📊 Run result:', runResult);

                    if (runResult.required_action && runResult.required_action.type === 'submit_tool_outputs') {
                        console.log('🔧 Found tool outputs to submit');

                        const toolCalls = runResult.required_action.submit_tool_outputs.tool_calls;
                        console.log('🔧 Tool calls found:', toolCalls.length);

                        const toolOutputs = [];
                        let stamps = [];
                        let structuredData = null;

                        for (const toolCall of toolCalls) {
                            console.log('🔧 Processing tool call:', toolCall);
                            if (toolCall.function.name === 'return_stamp_data') {
                                try {
                                    const functionArgs = JSON.parse(toolCall.function.arguments);
                                    console.log('📊 Function call data:', functionArgs);

                                    if (functionArgs.stamps && Array.isArray(functionArgs.stamps)) {
                                        stamps = functionArgs.stamps;
                                        structuredData = functionArgs;
                                        console.log(`✅ Found ${stamps.length} stamps from function call`);
                                    }
                                } catch (error) {
                                    console.log('❌ Error parsing function arguments:', error);
                                }
                            }

                            toolOutputs.push({
                                tool_call_id: toolCall.id,
                                output: JSON.stringify({ success: true, stamps: stamps }),
                            });
                        }

                        // Create structured data immediately from function call
                        let immediateStructuredData = null;
                        if (stamps.length === 1) {
                            console.log('🎴 Creating single stamp card with data:', stamps[0]);
                            immediateStructuredData = generateStampCard(stamps[0]);
                            console.log('🎴 Generated card data:', immediateStructuredData);
                        } else if (stamps.length > 1) {
                            console.log(`🎠 Creating carousel with ${stamps.length} stamps`);
                            immediateStructuredData = generateStampCarousel(stamps.slice(0, 5));
                            console.log('🎠 Generated carousel data:', immediateStructuredData);
                        }

                        // Return immediately with function call data
                        return {
                            response: `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`,
                            stampsFound: stamps.length,
                            hasStructuredData: stamps.length > 0,
                            stamps: stamps,
                            structuredData: immediateStructuredData,
                        };
                    }
                }

                // Get the messages from the thread
                const messages = await openai.beta.threads.messages.list(thread.id);
                console.log('📨 Messages in thread:', messages.data.length);

                // Get the latest assistant message
                const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
                console.log('🤖 Assistant messages found:', assistantMessages.length);

                if (assistantMessages.length > 0) {
                    const latestAssistantMessage = assistantMessages[0]; // Most recent is first
                    console.log('📝 Latest assistant message content length:', latestAssistantMessage.content.length);

                    if (latestAssistantMessage.content.length > 0) {
                        const content = latestAssistantMessage.content[0];
                        console.log('📄 Content type:', content.type);

                        if (content.type === 'text') {
                            const rawResponse = content.text.value;
                            console.log('🤖 Assistant response:', rawResponse);
                            console.log('Response length:', rawResponse.length);
                            console.log('Contains JSON:', rawResponse.includes('{'));
                            console.log('Contains real image URLs:', rawResponse.includes('3pmplatformstorage.blob.core.windows.net'));

                            // Clean the response to remove technical references
                            const response = cleanResponseText(rawResponse);
                            console.log('🧹 Cleaned response:', response);

                            // Check for function calls in the message
                            let stamps = [];
                            let structuredData = null;
                            let hasFunctionCalls = false;

                            // Look for function calls in the message
                            for (const contentItem of latestAssistantMessage.content) {
                                if (contentItem.type === 'tool_calls') {
                                    console.log('🔧 Found function calls in assistant message');
                                    console.log('🔧 Tool calls content:', contentItem);
                                    hasFunctionCalls = true;

                                    for (const toolCall of contentItem.tool_calls) {
                                        console.log('🔧 Tool call:', toolCall);
                                        if (toolCall.function.name === 'return_stamp_data') {
                                            try {
                                                const functionArgs = JSON.parse(toolCall.function.arguments);
                                                console.log('📊 Function call data:', functionArgs);

                                                if (functionArgs.stamps && Array.isArray(functionArgs.stamps)) {
                                                    stamps = functionArgs.stamps;
                                                    structuredData = functionArgs;
                                                    console.log(`✅ Found ${stamps.length} stamps from function call`);
                                                }
                                            } catch (error) {
                                                console.log('❌ Error parsing function arguments:', error);
                                            }
                                        }
                                    }
                                }
                            }

                            // If we have function calls, submit the results and get final response
                            if (hasFunctionCalls) {
                                console.log('🔄 Function call detected - displaying data immediately');

                                // Create structured data immediately from function call
                                let immediateStructuredData = null;
                                if (stamps.length === 1) {
                                    immediateStructuredData = generateStampCard(stamps[0]);
                                } else if (stamps.length > 1) {
                                    immediateStructuredData = generateStampCarousel(stamps.slice(0, 5));
                                }

                                // Return immediately with function call data
                                return {
                                    response: `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`,
                                    stampsFound: stamps.length,
                                    hasStructuredData: stamps.length > 0,
                                    stamps: stamps,
                                    structuredData: immediateStructuredData,
                                };
                            } else {
                                // No function calls - this is a generic response, no structured data needed
                                console.log('🔍 No function calls found - this is a generic response');

                                return {
                                    response: response,
                                    stampsFound: 0,
                                    hasStructuredData: false,
                                    stamps: [],
                                    structuredData: null,
                                };
                            }
                        } else {
                            console.log('❌ Content is not text type:', content.type);
                        }
                    } else {
                        console.log('❌ Assistant message has no content');
                    }
                } else {
                    console.log('❌ No assistant messages found in thread');
                }

                return {
                    response: 'I apologize, but I encountered an error while processing your request. Please try again in a moment.',
                    stamps: [],
                };
            })();

            // Race between the assistant call and timeout
            assistantResult = await Promise.race([assistantPromise, timeoutPromise]);

        } catch (error) {
            console.error('Assistant API error:', error);
            console.error('Error details:', {
                message: error instanceof Error ? error.message : 'Unknown error',
                status: error?.status,
                type: error?.type,
            });

            // Check if it's a timeout error
            if (error instanceof Error && error.message === 'Request timeout') {
                return res.status(408).json({
                    error: 'The assistant is taking too long to respond. Please try again with a more specific query about stamps, or try asking about a particular country or year.',
                });
            }

            assistantResult = {
                response: 'I apologize, but I encountered an error while processing your request. Please try again in a moment.',
                stamps: [],
            };
        }

        let foundStamps = [];
        let aiResponse = assistantResult.response;

        console.log('Assistant result:', {
            response: assistantResult.response,
            stampsFound: assistantResult.stamps?.length || 0,
            hasStructuredData: !!assistantResult.structuredData,
        });

        // Use assistant results - even if no structured data, use the response
        if (assistantResult.stamps && assistantResult.stamps.length > 0) {
            console.log(`Assistant found ${assistantResult.stamps.length} stamps`);
            foundStamps = assistantResult.stamps;

            // Use the full assistant response for conversational display
            aiResponse = assistantResult.response;
        } else {
            console.log('No structured data found, but using assistant response');
            aiResponse = assistantResult.response || "I couldn't find specific stamps matching your query in my database. Try searching for different terms or ask about general philatelic topics.";
        }

        // Generate structured data for UI display ONLY if we have stamps from function calls
        let structuredData = null;
        if (foundStamps.length === 1) {
            console.log('🎴 Generating single stamp card with data:', foundStamps[0]);
            structuredData = generateStampCard(foundStamps[0]);
            console.log('🎴 Generated card data:', structuredData);
        } else if (foundStamps.length > 1) {
            console.log(`🎠 Generating carousel with ${foundStamps.length} stamps`);
            structuredData = generateStampCarousel(foundStamps.slice(0, 5)); // Limit to 5 stamps in carousel
            console.log('🎠 Generated carousel data:', structuredData);
        } else {
            console.log('📝 No stamps found - no structured data generated');
        }

        console.log('📤 Final response data:', {
            response: aiResponse,
            structuredData: structuredData,
            foundStamps: foundStamps.length,
        });

        return res.json({
            response: aiResponse,
            structuredData,
            foundStamps: foundStamps.length,
            metadata: {
                source: foundStamps.length > 0 ? 'openai_assistant' : 'internet_search',
            },
        });

    } catch (error) {
        console.error('PhilaGuide API error:', error);
        return res.status(408).json({
            error: 'Request timed out. Please try again.',
        });
    }
});

app.post('/api/search-by-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        const imageFile = req.file;

        // Validate file type
        if (!imageFile.mimetype.startsWith('image/')) {
            return res.status(400).json({ error: 'Invalid file type. Please upload an image.' });
        }

        // Validate file size (max 5MB)
        if (imageFile.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'File size too large. Please upload an image smaller than 5MB.' });
        }

        console.log('🔍 Processing image search...');
        console.log('📁 File:', imageFile.originalname, 'Size:', imageFile.size, 'Type:', imageFile.mimetype);

        const base64Image = imageFile.buffer.toString('base64');

        // Process image with timeout
        try {
            // Create a timeout promise
            const timeoutPromise = createTimeoutPromise(TIMEOUT_MS);

            // Create the image processing promise
            const imageProcessingPromise = (async () => {
                // Step 1: Analyze if the image is a stamp
                const stampAnalysis = await analyzeStampImage(base64Image);

                if (!stampAnalysis.isStamp) {
                    return {
                        isStamp: false,
                        confidence: stampAnalysis.confidence,
                        message: 'This image does not appear to be a stamp.',
                    };
                }

                // Step 2: If it's a stamp, find similar stamps in our database
                const similarStamps = await findSimilarStamps(stampAnalysis.description);

                // Step 3: Get the best match
                const bestMatch = similarStamps.length > 0 ? similarStamps[0] : null;

                return {
                    isStamp: true,
                    confidence: stampAnalysis.confidence,
                    stampDetails: bestMatch ? {
                        name: bestMatch.Name,
                        country: bestMatch.Country,
                        denomination: `${bestMatch.DenominationValue}${bestMatch.DenominationSymbol || ''}`,
                        year: bestMatch.IssueYear || 'Unknown',
                        color: bestMatch.Color || 'Unknown',
                        description: bestMatch.visualDescription || 'No description available',
                        imageUrl: bestMatch.StampImageUrl || '/images/stamps/no-image-available.png',
                    } : null,
                    suggestions: similarStamps.slice(0, 4).map(stamp => ({
                        name: stamp.Name,
                        country: stamp.Country,
                        similarity: stamp.similarity || 0.8,
                        imageUrl: stamp.StampImageUrl || '/images/stamps/no-image-available.png',
                    })),
                };
            })();

            // Race between the image processing and timeout
            const result = await Promise.race([imageProcessingPromise, timeoutPromise]);

            return res.json(result);

        } catch (error) {
            console.error('❌ Error in image processing:', error);

            // Check if it's a timeout error
            if (error instanceof Error && error.message === 'Request timeout') {
                return res.status(408).json({
                    error: 'Image processing timed out. Please try again with a simpler image.',
                });
            }

            return res.status(500).json({
                error: 'Failed to process image. Please try again.',
            });
        }

    } catch (error) {
        console.error('❌ Error in image search:', error);
        return res.status(500).json({
            error: 'Failed to process image. Please try again.',
        });
    }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

async function analyzeStampImage(base64Image) {
    try {
        console.log('🔍 Analyzing image with OpenAI Vision...');

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analyze this image and determine if it's a postage stamp. Provide a detailed description of what you see.\n\nRequirements:\n1. Determine if this is a postage stamp (not a coin, banknote, or other item)\n2. If it IS a stamp, provide a detailed description including:\n   - Country name\n   - Denomination/value\n   - Colors used\n   - Main subject/theme (portrait, animal, building, etc.)\n   - Text elements visible\n   - Any distinctive features\n   - Approximate year/era if visible\n\n3. If it's NOT a stamp, explain why not\n\n4. Provide a confidence score (0-1) for your assessment\n\n5. Format your response as JSON:\n{\n  \"isStamp\": true/false,\n  \"confidence\": 0.95,\n  \"description\": \"Detailed description of the stamp...\",\n  \"country\": \"Country name if visible\",\n  \"denomination\": \"Value/denomination if visible\",\n  \"colors\": [\"color1\", \"color2\"],\n  \"subject\": \"Main subject/theme\",\n  \"year\": \"Approximate year if visible\"\n}`,
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`,
                            },
                        },
                    ],
                },
            ],
            max_tokens: 1000,
        });

        const analysisText = response.choices[0]?.message?.content;
        console.log('📊 Analysis result:', analysisText);

        if (!analysisText) {
            throw new Error('No analysis result received');
        }

        // Try to parse JSON response
        try {
            const analysis = JSON.parse(analysisText);
            return {
                isStamp: analysis.isStamp || false,
                confidence: analysis.confidence || 0.5,
                description: analysis.description || '',
                country: analysis.country || '',
                denomination: analysis.denomination || '',
                colors: analysis.colors || [],
                subject: analysis.subject || '',
                year: analysis.year || '',
            };
        } catch (parseError) {
            console.log('⚠️ Could not parse JSON response, using text analysis');

            // Fallback: analyze the text response
            const text = analysisText.toLowerCase();
            const isStamp = text.includes('stamp') || text.includes('postage');
            const confidence = isStamp ? 0.7 : 0.3;

            return {
                isStamp,
                confidence,
                description: analysisText,
                country: '',
                denomination: '',
                colors: [],
                subject: '',
                year: '',
            };
        }

    } catch (error) {
        console.error('❌ Error analyzing image:', error);
        return {
            isStamp: false,
            confidence: 0.1,
            description: 'Unable to analyze image',
            country: '',
            denomination: '',
            colors: [],
            subject: '',
            year: '',
        };
    }
}

async function findSimilarStamps(description) {
    try {
        console.log('🔍 Finding similar stamps...');

        // Load our stamp database
        // Adjust path as necessary if stamps-with-descriptions.json is not in the same directory
        const stampsFile = './stamps-with-descriptions.json';

        if (!fs.existsSync(stampsFile)) {
            console.log('⚠️ No enhanced stamps file found, using basic search');
            return [];
        }

        const stamps = JSON.parse(fs.readFileSync(stampsFile, 'utf8'));
        console.log(`📊 Searching through ${stamps.length} stamps`);

        // Simple keyword-based similarity search
        const searchTerms = description.toLowerCase().split(' ');
        const results = stamps
            .filter(stamp => {
                if (!stamp.visualDescription) return false;

                const stampText = `${stamp.Name} ${stamp.Country} ${stamp.Color || ''} ${stamp.visualDescription}`.toLowerCase();

                // Count matching keywords
                const matches = searchTerms.filter(term =>
                    stampText.includes(term) && term.length > 2,
                ).length;

                return matches > 0;
            })
            .map(stamp => {
                const stampText = `${stamp.Name} ${stamp.Country} ${stamp.Color || ''} ${stamp.visualDescription}`.toLowerCase();
                const matches = searchTerms.filter(term =>
                    stampText.includes(term) && term.length > 2,
                ).length;

                return {
                    ...stamp,
                    similarity: Math.min(matches / searchTerms.length, 1),
                };
            })
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            .slice(0, 5);

        console.log(`✅ Found ${results.length} similar stamps`);
        return results;

    } catch (error) {
        console.error('❌ Error finding similar stamps:', error);
        return [];
    }
} 