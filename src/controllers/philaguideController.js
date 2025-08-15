
const { openai, ASSISTANT_ID, TIMEOUT_MS } = require('../utils/openai');
const { createTimeoutPromise, generateStampCard, generateStampCarousel, cleanResponseText } = require('../utils/helpers');

const activeThreads = new Map(); // sessionId -> threadId

// Streaming response handler
async function handleStreamingResponse(message, conversationHistory = [], sessionId, res) {
    const encoder = new TextEncoder();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=1000');

    try {
        console.log('🔄 Starting streaming response for:', message);
        console.log('🔄 Conversation history length:', conversationHistory.length);

        // Step 1: Get or create thread based on session
        let threadId;
        if (sessionId && activeThreads.has(sessionId)) {
            // Use existing thread for conversation continuity
            threadId = activeThreads.get(sessionId);
            console.log('🔄 Using existing thread:', threadId);

            // Check if there are any runs in progress and wait for them to complete
            try {
                const runs = await openai.beta.threads.runs.list(threadId);
                const activeRuns = runs.data.filter(run =>
                    run.status === 'queued' || run.status === 'in_progress' || run.status === 'requires_action'
                );

                if (activeRuns.length > 0) {
                    console.log(`⏳ Found ${activeRuns.length} active runs, waiting for completion...`);
                    for (const activeRun of activeRuns) {
                        console.log(`⏳ Waiting for run ${activeRun.id} (status: ${activeRun.status}) to complete...`);

                        if (activeRun.status === 'requires_action') {
                            console.log('🔧 Run requires action, handling it...');
                            console.log('⏳ Waiting for requires_action run to complete...');
                        } else {
                            let runStatusCheck = activeRun.status;
                            let attemptsCheck = 0;
                            const maxAttemptsCheck = 30; // Wait up to 30 seconds

                            while ((runStatusCheck === 'queued' || runStatusCheck === 'in_progress') && attemptsCheck < maxAttemptsCheck) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                try {
                                    const runResult = await openai.beta.threads.runs.retrieve(activeRun.id, { thread_id: threadId });
                                    runStatusCheck = runResult.status;
                                    attemptsCheck++;
                                    console.log(`⏳ Active run status: ${runStatusCheck} (attempt ${attemptsCheck}/${maxAttemptsCheck})`);
                                    if (runStatusCheck === 'completed' || runStatusCheck === 'failed' || runStatusCheck === 'cancelled' || runStatusCheck === 'requires_action') {
                                        break;
                                    }
                                } catch (error) {
                                    console.error('❌ Error checking active run status:', error);
                                    break;
                                }
                            }
                        }
                    }
                    console.log('✅ All active runs completed');
                }
            } catch (error) {
                console.error('❌ Error checking active runs:', error);
            }
        } else {
            // Create new thread for new conversation
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            if (sessionId) {
                activeThreads.set(sessionId, threadId);
            }
            console.log('✅ New thread created:', threadId);
        }

        // Add current message to thread (OpenAI manages history automatically)
        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: message,
        });
        console.log('✅ Message added to thread');

        // Step 3: Create run with the assistant
        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: ASSISTANT_ID,
        });
        console.log('✅ Run created:', run.id);

        // Step 4: Stream the response
        await streamRunResponse(threadId, run.id, res, encoder);

        res.end();

    } catch (error) {
        console.error('❌ Streaming error:', error);
        const errorMessage = `data: ${JSON.stringify({ error: 'Failed to process request' })}\n\n`;
        try {
            res.write(encoder.encode(errorMessage));
        } catch (controllerError) {
            console.log('Controller closed, cannot send error message');
        }
        res.end();
    }
}

// Handle voice chat with direct chat completion (no assistant API)
async function handleVoiceChatDirect(message, conversationHistory = [], res, encoder) {
    try {
        console.log('🎤 Starting direct voice chat for:', message);
        console.log('🎤 Conversation history length:', conversationHistory.length);

        // Send initial status
        const statusMessage = `data: ${JSON.stringify({ type: 'status', status: 'processing' })}\n\n`;
        res.write(encoder.encode(statusMessage));

        // Build conversation context with history
        const messages = [
            {
                role: "system",
                content: `You are a helpful stamp expert assistant specializing in conversational responses for voice synthesis. 

IMPORTANT GUIDELINES:
- Provide natural, conversational responses suitable for speech
- Use clear, descriptive language
- Avoid abbreviations and technical jargon
- Use complete sentences and natural speech patterns
- Be informative but friendly and engaging
- When describing stamps, include details like country, year, denomination, color, and interesting facts
- Use natural language for denominations (e.g., "one-third penny" instead of "1/3d")
- NEVER use function calls or structured data - provide direct conversational responses
- Focus on descriptive, engaging content that sounds natural when spoken
- Maintain conversation context from previous messages
- Reference previous topics when relevant to show continuity

Example: Instead of "1/3d stamp from NZ", say "This is a beautiful one-third penny stamp from New Zealand, issued in 1935, featuring a stunning blue color that makes it highly collectible."

You have access to stamp knowledge and can provide detailed, conversational information about stamps. Always respond in a natural, conversational manner suitable for voice synthesis.`
            },
            ...conversationHistory,
            {
                role: "user",
                content: message
            }
        ];

        console.log('🎤 Messages being sent to OpenAI:', messages.length, 'total messages');

        const stream = await openai.chat.completions.create({
            model: "gpt-4o",
            messages,
            stream: true,
            max_tokens: 1500,
            temperature: 0.7
        });

        let accumulatedContent = "";

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                accumulatedContent += content;

                const contentMessage = `data: ${JSON.stringify({ type: 'content', content: content })}\n\n`;
                try {
                    res.write(encoder.encode(contentMessage));
                } catch (controllerError) {
                    console.log('🎤 Controller closed, stopping stream');
                    break;
                }
            }
        }

        const completeMessage = `data: ${JSON.stringify({ type: 'complete', content: accumulatedContent })}\n\n`;
        try {
            res.write(encoder.encode(completeMessage));
        } catch (controllerError) {
            console.log('🎤 Controller already closed');
        }

        console.log('🎤 Voice chat completed with content length:', accumulatedContent.length);
        res.end();

    } catch (error) {
        console.error('❌ Voice chat error:', error);
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to process voice chat request' })}\n\n`;
        try {
            res.write(encoder.encode(errorMessage));
        } catch (controllerError) {
            console.log('🎤 Controller closed, cannot send error message');
        }
        res.end();
    }
}

// Stream run response
async function streamRunResponse(threadId, runId, res, encoder) {
    let runStatus = 'queued';
    let attempts = 0;
    const maxAttempts = 15; // 15 seconds max to allow for function calls

    try {
        while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
            console.log(`⏳ Run status: ${runStatus} (attempt ${attempts + 1}/${maxAttempts})`);

            // Send status update
            const statusMessage = `data: ${JSON.stringify({ type: 'status', status: runStatus })}\n\n`;
            try {
                res.write(encoder.encode(statusMessage));
            } catch (error) {
                console.log('Controller closed during status update, stopping');
                return;
            }

            // Send keep-alive signal every 5 seconds to prevent idle timeout
            if (attempts % 5 === 0) {
                const keepAliveMessage = `data: ${JSON.stringify({ type: 'keep-alive', timestamp: Date.now() })}\n\n`;
                try {
                    res.write(encoder.encode(keepAliveMessage));
                } catch (error) {
                    console.log('Keep-alive signal failed, connection may be closed');
                    break;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            try {
                const runResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });
                runStatus = runResult.status;
                attempts++;

                if (runResult.last_error) {
                    console.error('❌ Run error:', runResult.last_error);
                    const errorMessage = `data: ${JSON.stringify({ type: 'error', error: runResult.last_error })}\n\n`;
                    try {
                        res.write(encoder.encode(errorMessage));
                    } catch (error) {
                        console.log('Controller closed during error message, stopping');
                        return;
                    }
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
            try {
                res.write(encoder.encode(errorMessage));
            } catch (error) {
                console.log('Controller closed during error message, stopping');
                return;
            }
            return;
        }

        if (runStatus === 'queued' || runStatus === 'in_progress') {
            const timeoutMessage = `data: ${JSON.stringify({ type: 'timeout', message: 'Processing is taking longer than expected. Please try a more specific query about stamps, or ask about a particular country or year.' })}\n\n`;
            try {
                res.write(encoder.encode(timeoutMessage));
            } catch (error) {
                console.log('Controller closed during timeout message, stopping');
                return;
            }
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
                                try {
                                    res.write(encoder.encode(previewMessage));
                                } catch (error) {
                                    console.log('Controller closed during preview message, stopping');
                                    return;
                                }

                                // Also send raw stamp data for voice chat
                                const rawStampData = {
                                    count: stamps.length,
                                    stamps: stamps.slice(0, 5), // Send the raw stamp objects
                                };

                                console.log('📤 Sending raw stamp data for voice chat:', rawStampData);
                                const rawDataMessage = `data: ${JSON.stringify({ type: 'raw_stamp_data', data: rawStampData })}\n\n`;
                                try {
                                    res.write(encoder.encode(rawDataMessage));
                                } catch (error) {
                                    console.log('Controller closed during raw data message, stopping');
                                    return;
                                }
                            } else {
                                console.log('⚠️ No stamps array found in function call data');
                            }
                        } catch (error) {
                            console.log('❌ Error parsing function arguments:', error);
                        }
                    }

                    toolOutputs.push({
                        tool_call_id: toolCall.id,
                        output: JSON.stringify({
                            success: true,
                            stamps: stamps,
                            instructions: "🚨 CRITICAL INSTRUCTIONS - YOU MUST FOLLOW THESE EXACTLY: ❌ NEVER list basic stamp details like Country, Issue Date, Catalog Code, Denomination, Color, or Paper Type. These are already displayed in the card above. ✅ INSTEAD, write ONLY about: Historical significance, design elements, cultural importance, interesting stories, collecting insights, philatelic significance, and series context. Focus on the STORY behind the stamp, not repeating the data. Example: 'This stamp captures the dynamic beauty of New Zealand's native trout in a stunning artistic composition that celebrates the country's freshwater fishing heritage.' NOT 'Country: New Zealand, Issue Date: May 4, 1935, Color: Blue'",
                        }),
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

                // Send structured data
                if (immediateStructuredData) {
                    console.log('📤 Sending structured data to frontend:', immediateStructuredData.type);
                    const structuredMessage = `data: ${JSON.stringify({ type: 'structured_data', data: immediateStructuredData })}\n\n`;
                    try {
                        res.write(encoder.encode(structuredMessage));
                    } catch (error) {
                        console.log('Controller closed during structured data message, stopping');
                        return;
                    }
                } else {
                    console.log('⚠️ No structured data to send');
                }

                // CRITICAL: Submit tool outputs back to the thread to complete the conversation
                if (toolOutputs.length > 0) {
                    try {
                        console.log('📤 Submitting tool outputs back to thread:', toolOutputs.length, 'outputs');
                        await openai.beta.threads.runs.submitToolOutputs(runId, {
                            thread_id: threadId,
                            tool_outputs: toolOutputs,
                        });
                        console.log('✅ Tool outputs submitted successfully');

                        // Wait for the run to complete after submitting tool outputs
                        console.log('⏳ Waiting for run to complete after tool output submission...');
                        let finalRunStatus = 'in_progress';
                        let finalAttempts = 0;
                        const maxFinalAttempts = 10; // Wait up to 10 seconds for completion

                        while (finalRunStatus === 'in_progress' && finalAttempts < maxFinalAttempts) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            try {
                                const finalRunResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });
                                finalRunStatus = finalRunResult.status;
                                finalAttempts++;
                                console.log(`⏳ Final run status: ${finalRunStatus} (attempt ${finalAttempts}/${maxFinalAttempts})`);

                                if (finalRunStatus === 'completed') {
                                    console.log('✅ Run completed successfully after tool output submission');
                                    break;
                                } else if (finalRunStatus === 'failed' || finalRunStatus === 'cancelled') {
                                    console.log(`❌ Run ${finalRunStatus} after tool output submission`);
                                    break;
                                }
                            } catch (error) {
                                console.error('❌ Error checking final run status:', error);
                                break;
                            }
                        }

                        // If the run completed, stream the final response
                        if (finalRunStatus === 'completed') {
                            console.log('📤 Streaming final response after tool output submission');
                            await streamMessages(threadId, res, encoder);
                            console.log('✅ Final response streamed, exiting early');
                        }
                    } catch (submitError) {
                        console.error('❌ Error submitting tool outputs:', submitError);
                    }
                }
                return;
            }
        }

        // Get the messages and stream the response (only if we didn't handle it above)
        if (runStatus === 'completed') {
            console.log('📤 Streaming response for completed run (no tool outputs)');
            await streamMessages(threadId, res, encoder);
        } else {
            console.log(`📤 Run ended with status: ${runStatus}, no response to stream`);
        }
    } catch (error) {
        console.error('❌ Error in streamRunResponse:', error);
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to process request' })}\n\n`;
        try {
            res.write(encoder.encode(errorMessage));
        } catch (controllerError) {
            console.log('Controller closed during error message, stopping');
            return;
        }
    }
}

// Stream messages from thread
async function streamMessages(threadId, res, encoder) {
    try {
        console.log('📤 Starting streamMessages');

        const messages = await openai.beta.threads.messages.list(threadId);
        const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');

        if (assistantMessages.length > 0) {
            const latestMessage = assistantMessages[0];

            if (latestMessage.content.length > 0) {
                const content = latestMessage.content[0];

                if (content.type === 'text') {
                    const text = content.text.value;
                    const cleanedText = cleanResponseText(text);
                    console.log('📝 Streaming text content, length:', cleanedText.length);

                    // BULLETPROOF: Send complete response immediately to prevent any loss
                    const completeResponseMessage = `data: ${JSON.stringify({ type: 'complete_response', content: cleanedText })}\n\n`;
                    try {
                        res.write(encoder.encode(completeResponseMessage));
                        console.log('✅ Complete response sent immediately to prevent loss');
                    } catch (completeError) {
                        console.log('❌ Could not send complete response');
                    }

                    // Send initial connection establishment signal
                    const connectionMessage = `data: ${JSON.stringify({ type: 'connection', status: 'established', contentLength: cleanedText.length })}\n\n`;
                    try {
                        res.write(encoder.encode(connectionMessage));
                        console.log('🔗 Connection established signal sent');
                    } catch (connectionError) {
                        console.log('❌ Connection signal failed');
                    }

                    let completeResponse = '';
                    let streamedWords = 0;
                    const totalWords = cleanedText.split(' ').length;

                    const words = cleanedText.split(' ');
                    const chunkSize = 5;

                    for (let i = 0; i < words.length; i += chunkSize) {
                        const chunk = words.slice(i, i + chunkSize);
                        const chunkText = chunk.join(' ');
                        const message = `data: ${JSON.stringify({ type: 'content', content: chunkText + (i + chunkSize < words.length ? ' ' : '') })}` + '\n\n';

                        try {
                            res.write(encoder.encode(message));
                            streamedWords = Math.min(i + chunkSize, words.length);
                            completeResponse += chunkText + (i + chunkSize < words.length ? ' ' : '');
                            console.log(`📤 Streamed chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(words.length / chunkSize)}: "${chunkText}" (words ${i + 1}-${streamedWords})`);

                            if (Math.floor(i / chunkSize) % 3 === 0 && i > 0) {
                                const keepAliveMessage = `data: ${JSON.stringify({ type: 'keep-alive', chunk: Math.floor(i / chunkSize), total: Math.ceil(words.length / chunkSize) })}\n\n`;
                                try {
                                    res.write(encoder.encode(keepAliveMessage));
                                    console.log(`📡 Keep-alive signal sent at chunk ${Math.floor(i / chunkSize)}`);
                                } catch (keepAliveError) {
                                    console.log('❌ Keep-alive signal failed');
                                }
                            }
                        } catch (error) {
                            console.log('❌ Controller closed during content streaming, stopping at word', i);
                            console.log('📤 Complete response already sent at start - no content loss');
                            return;
                        }

                        await new Promise(resolve => setTimeout(resolve, 50));
                    }

                    console.log('✅ Content streaming completed successfully');

                    const completeMessage = `data: ${JSON.stringify({ type: 'complete' })}\n\n`;
                    try {
                        res.write(encoder.encode(completeMessage));
                        console.log('✅ Completion signal sent successfully');
                    } catch (error) {
                        console.log('❌ Controller closed during completion message');
                        return;
                    }
                } else {
                    console.log('⚠️ No text content found in message');
                }
            }
        } else {
            console.log('⚠️ No assistant messages found');
        }
    } catch (error) {
        console.error('❌ Error streaming messages:', error);
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to get response' })}\n\n`;

        try {
            res.write(encoder.encode(errorMessage));
            console.log('✅ Error message sent successfully');
        } catch (controllerError) {
            console.log('❌ Controller closed during error message');
            return;
        }
    }

    console.log('📤 streamMessages function completed');
}

async function handlePhilaguideRequest(req, res) {
    try {
        const { message, stream = false, voiceChat = false, sessionId, history = [], conversationHistory = [] } = req.body;
        const finalHistory = conversationHistory.length > 0 ? conversationHistory : history;
        console.log('📨 API Request:', { message: message.substring(0, 50) + '...', stream, voiceChat, sessionId, historyLength: finalHistory.length });

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        if (stream) {
            // Pass voiceChat and sessionId to streaming handler
            if (voiceChat) {
                return handleVoiceChatDirect(message, finalHistory, res, new TextEncoder());
            } else {
                return handleStreamingResponse(message, finalHistory, sessionId, res);
            }
        }

        console.log('Using non-streaming mode for:', message);

        if (voiceChat) {
            console.log('🎤 Using direct chat completion for voice chat (non-streaming) with history length:', finalHistory.length);

            try {
                const messages = [
                    {
                        role: "system",
                        content: `You are a helpful stamp expert assistant specializing in conversational responses for voice synthesis. 

IMPORTANT GUIDELINES:
- Provide natural, conversational responses suitable for speech
- Use clear, descriptive language
- Avoid abbreviations and technical jargon
- Use complete sentences and natural speech patterns
- Be informative but friendly and engaging
- When describing stamps, include details like country, year, denomination, color, and interesting facts
- Use natural language for denominations (e.g., "one-third penny" instead of "1/3d")
- NEVER use function calls or structured data - provide direct conversational responses
- Focus on descriptive, engaging content that sounds natural when spoken
- Maintain conversation context from previous messages
- Reference previous topics when relevant to show continuity

Example: Instead of "1/3d stamp from NZ", say "This is a beautiful one-third penny stamp from New Zealand, issued in 1935, featuring a stunning blue color that makes it highly collectible."

You have access to stamp knowledge and can provide detailed, conversational information about stamps. Always respond in a natural, conversational manner suitable for voice synthesis.`
                    },
                    ...finalHistory,
                    {
                        role: "user",
                        content: message
                    }
                ];

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages,
                    max_tokens: 1500,
                    temperature: 0.7
                });

                const response = completion.choices[0]?.message?.content || "I couldn't generate a response for that query.";
                return res.json({ response });

            } catch (error) {
                console.error('❌ Voice chat error:', error);
                return res.status(500).json({ error: 'Failed to process voice chat request' });
            }
        }

        console.log('Using OpenAI Assistant for:', message);

        let assistantResult;
        try {
            const timeoutPromise = createTimeoutPromise(TIMEOUT_MS);

            const assistantPromise = (async () => {
                const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
                console.log('✅ Assistant fetched:', assistant.id);

                let threadId;
                if (sessionId && activeThreads.has(sessionId)) {
                    threadId = activeThreads.get(sessionId);
                    console.log('🔄 Using existing thread:', threadId);
                } else {
                    const thread = await openai.beta.threads.create();
                    threadId = thread.id;
                    if (sessionId) {
                        activeThreads.set(sessionId, threadId);
                    }
                    console.log('✅ New thread created:', threadId);
                }

                const enhancedMessage = `${message}

🚨 CRITICAL - YOU MUST FOLLOW THESE INSTRUCTIONS EXACTLY:

❌ ABSOLUTELY FORBIDDEN - NEVER INCLUDE:
- Country names
- Issue dates  
- Catalog codes
- Denominations
- Colors
- Paper types
- ANY basic stamp details

✅ INSTEAD, WRITE ONLY ABOUT:
- Historical significance and stories
- Design and artistic elements
- Cultural importance
- Interesting facts and trivia
- Collecting insights
- Philatelic significance
- Series context and relationships

🚨 REMEMBER: The user already sees all basic details in the card above. Your job is to provide the STORY behind the stamp, not repeat the data.

Example of CORRECT response: "This stamp captures the dynamic beauty of New Zealand's native trout in a stunning artistic composition. The leaping fish design celebrates the country's world-renowned freshwater fishing heritage and represents the pristine natural ecosystems that make New Zealand unique. Part of the iconic 1935-1947 Pictorial Issue series, this stamp showcases the artistic excellence and cultural storytelling that defined this golden era of New Zealand philately."

Example of WRONG response: "Name: Trout Blue 1/3d, Country: New Zealand, Issue Date: May 4, 1935, Color: Blue" (NEVER DO THIS)

Focus on the STORY, not the DATA.`
;

                const threadMessage = await openai.beta.threads.messages.create(threadId, {
                    role: 'user',
                    content: enhancedMessage,
                });
                console.log('✅ Message created:', threadMessage.id);

                const run = await openai.beta.threads.runs.create(threadId, {
                    assistant_id: assistant.id,
                });
                console.log('✅ Run created:', run.id);

                if (!run.id) {
                    throw new Error('Failed to create run - no run ID returned');
                }

                console.log('⏳ Waiting for run to complete...');
                let runStatus = run.status;
                let attempts = 0;
                const maxAttempts = 4;

                while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
                    console.log(`⏳ Run status: ${runStatus} (attempt ${attempts + 1}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    try {
                        const runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId });
                        runStatus = runResult.status;
                        attempts++;

                        if (runResult.last_error) {
                            console.error('❌ Run error:', runResult.last_error);
                        }
                    } catch (error) {
                        console.error('❌ Error checking run status:', error);
                        break;
                    }
                }

                console.log(`✅ Run completed with status: ${runStatus}`);

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

                if (runStatus === 'queued' || runStatus === 'in_progress') {
                    console.log('⏰ Run still in progress after timeout, returning quick response');
                    return {
                        response: "I'm processing your request about stamps. This might take a moment. Please try again with a more specific query about stamps, or check back in a few seconds.",
                        stampsFound: 0,
                        hasStructuredData: false,
                        stamps: [],
                        structuredData: null,
                    };
                }

                if (runStatus === 'requires_action') {
                    console.log('🔧 Run requires action - handling function calls...');

                    const runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId });
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

                        if (toolOutputs.length > 0) {
                            try {
                                console.log('📤 Submitting tool outputs back to thread (non-streaming):', toolOutputs.length, 'outputs');
                                await openai.beta.threads.runs.submitToolOutputs(run.id, {
                                    thread_id: threadId,
                                    tool_outputs: toolOutputs,
                                });
                                console.log('✅ Tool outputs submitted successfully (non-streaming)');

                                console.log('⏳ Waiting for run to complete after tool output submission (non-streaming)...');
                                let finalRunStatus = 'in_progress';
                                let finalAttempts = 0;
                                const maxFinalAttempts = 10;

                                while (finalRunStatus === 'in_progress' && finalAttempts < maxFinalAttempts) {
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                    try {
                                        const finalRunResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId });
                                        finalRunStatus = finalRunResult.status;
                                        finalAttempts++;
                                        console.log(`⏳ Final run status (non-streaming): ${finalRunStatus} (attempt ${finalAttempts}/${maxFinalAttempts})`);

                                        if (finalRunStatus === 'completed') {
                                            console.log('✅ Run completed successfully after tool output submission (non-streaming)');
                                            break;
                                        } else if (finalRunStatus === 'failed' || finalRunStatus === 'cancelled') {
                                            console.log(`❌ Run ${finalRunStatus} after tool output submission (non-streaming)`);
                                            break;
                                        }
                                    } catch (error) {
                                        console.error('❌ Error checking final run status (non-streaming):', error);
                                        break;
                                    }
                                }
                            } catch (submitError) {
                                console.error('❌ Error submitting tool outputs (non-streaming):', submitError);
                            }
                        }

                        return {
                            response: `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`,
                            stampsFound: stamps.length,
                            hasStructuredData: stamps.length > 0,
                            stamps: stamps,
                            structuredData: immediateStructuredData,
                        };
                    }
                }

                const messages = await openai.beta.threads.messages.list(threadId);
                console.log('📨 Messages in thread:', messages.data.length);

                const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
                console.log('🤖 Assistant messages found:', assistantMessages.length);

                if (assistantMessages.length > 0) {
                    const latestAssistantMessage = assistantMessages[0];
                    console.log('📝 Latest assistant message content length:', latestAssistantMessage.content.length);

                    if (latestAssistantMessage.content.length > 0) {
                        const content = latestAssistantMessage.content[0];
                        console.log('📄 Content type:', content.type);

                        if (content.type === 'text') {
                            const rawResponse = content.text.value;
                            console.log('🤖 Assistant response:', rawResponse);

                            const response = cleanResponseText(rawResponse);
                            console.log('🧹 Cleaned response:', response);

                            let stamps = [];
                            let structuredData = null;
                            let hasFunctionCalls = false;

                            for (const contentItem of latestAssistantMessage.content) {
                                if (contentItem.type === 'tool_calls') {
                                    console.log('🔧 Found function calls in assistant message');
                                    hasFunctionCalls = true;

                                    for (const toolCall of contentItem.tool_calls) {
                                        console.log('🔧 Tool call:', toolCall);
                                        if (toolCall.function.name === 'return_stamp_data') {
                                            try {
                                                const functionArgs = JSON.parse(toolCall.function.arguments);
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

                            if (hasFunctionCalls) {
                                console.log('🔄 Function call detected - displaying data immediately');
                                let immediateStructuredData = null;
                                if (stamps.length === 1) {
                                    immediateStructuredData = generateStampCard(stamps[0]);
                                } else if (stamps.length > 1) {
                                    immediateStructuredData = generateStampCarousel(stamps.slice(0, 5));
                                }

                                return {
                                    response: `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`,
                                    stampsFound: stamps.length,
                                    hasStructuredData: stamps.length > 0,
                                    stamps: stamps,
                                    structuredData: immediateStructuredData,
                                };
                            } else {
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

            assistantResult = await Promise.race([assistantPromise, timeoutPromise]);

        } catch (error) {
            console.error('Assistant API error:', error);
            console.error('Error details:', {
                message: error instanceof Error ? error.message : 'Unknown error',
                status: error?.status,
                type: error?.type,
            });

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

        if (assistantResult.stamps && assistantResult.stamps.length > 0) {
            console.log(`Assistant found ${assistantResult.stamps.length} stamps`);
            foundStamps = assistantResult.stamps;
            aiResponse = assistantResult.response;
        } else {
            console.log('No structured data found, but using assistant response');
            aiResponse = assistantResult.response || "I couldn't find specific stamps matching your query in my database. Try searching for different terms or ask about general philatelic topics.";
        }

        let structuredData = null;
        if (foundStamps.length === 1) {
            console.log('🎴 Generating single stamp card with data:', foundStamps[0]);
            structuredData = generateStampCard(foundStamps[0]);
            console.log('🎴 Generated card data:', structuredData);
        } else if (foundStamps.length > 1) {
            console.log(`🎠 Generating carousel with ${foundStamps.length} stamps`);
            structuredData = generateStampCarousel(foundStamps.slice(0, 5));
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
}

module.exports = {
    handlePhilaguideRequest,
};
