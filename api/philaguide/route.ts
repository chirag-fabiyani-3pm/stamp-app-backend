import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

// Vercel configuration
export const maxDuration = 15 // 15 seconds for Vercel hobby plan (allows for function calls)
export const dynamic = 'force-dynamic'

console.log('OPENAI_API_KEY (philaguide): ', process.env.OPENAI_API_KEY)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const ASSISTANT_ID = 'asst_AfsiDbpnx2WjgZV7O97eHhyb'

// Thread management - store active threads (in production, use a proper database)
const activeThreads = new Map<string, string>() // sessionId -> threadId

// Add timeout configuration for Vercel - must be much less than maxDuration
const TIMEOUT_MS = 8000 // Reduced to 8 seconds to complete before Vercel closes connection

// Timeout helper function
function createTimeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), ms)
    })
}



// Handle voice chat with direct chat completion (no assistant API)
async function handleVoiceChatDirect(message: string, conversationHistory: any[] = [], controller: ReadableStreamDefaultController, encoder: TextEncoder) {
    try {
        console.log('🎤 Starting direct voice chat for:', message)
        console.log('🎤 Conversation history length:', conversationHistory.length)

        // Send initial status
        const statusMessage = `data: ${JSON.stringify({ type: 'status', status: 'processing' })}\n\n`
        controller.enqueue(encoder.encode(statusMessage))

        // Build conversation context with history
        const messages = [
            {
                role: "system" as const,
                content: `You are a helpful stamp expert assistant specializing in comprehensive, conversational responses for voice synthesis. 

🚨 CRITICAL ANTI-HALLUCINATION RULES:
- NEVER invent or make up stamp details, names, countries, years, or any specific information
- NEVER provide fake stamp IDs, catalog numbers, or technical details
- If you don't know specific stamp information, say "I don't have specific details about that stamp" and provide general philatelic knowledge instead
- ONLY share information you are confident is accurate and factual
- When in doubt, err on the side of caution and provide general information rather than specific details

IMPORTANT GUIDELINES:
- Provide detailed, comprehensive responses that cover all aspects of the user's question
- Use natural, conversational language suitable for speech
- Use clear, descriptive language with rich details
- Avoid abbreviations and technical jargon
- Use complete sentences and natural speech patterns
- Be informative, friendly, and engaging
- When describing stamps, focus on general philatelic knowledge, collecting principles, and historical context
- Use natural language for denominations (e.g., "one-third penny" instead of "1/3d")
- NEVER use function calls or structured data - provide direct conversational responses
- Focus on descriptive, engaging content that sounds natural when spoken
- Maintain conversation context from previous messages
- Reference previous topics when relevant to show continuity
- Take time to provide thorough answers rather than rushing
- NEVER repeat yourself or use repetitive phrases
- Be concise and direct - avoid verbose explanations
- If you don't have specific data, provide brief, helpful guidance

Example: Instead of making up specific stamp details, say "New Zealand stamps often feature beautiful native wildlife and landscapes. When collecting stamps, it's important to look for factors like condition, rarity, and historical significance rather than just focusing on age or denomination."

You have access to general stamp knowledge and can provide helpful information about philately. Always respond honestly and never invent specific stamp details.`
            },
            ...conversationHistory, // Include conversation history for context
            {
                role: "user" as const,
                content: message
            }
        ]

        console.log('🎤 Messages being sent to OpenAI:', messages.length, 'total messages')

        // Create a streaming chat completion with enhanced system prompt and conversation history
        const stream = await openai.chat.completions.create({
            model: "gpt-4o",
            messages,
            stream: true,
            max_tokens: 800, // Reduced for faster voice responses to beat Vercel timeout
            temperature: 0.7
        })

        let accumulatedContent = ""
        let chunkCount = 0
        const maxChunks = 50 // Limit chunks to prevent long processing

        for await (const chunk of stream) {
            chunkCount++
            const content = chunk.choices[0]?.delta?.content
            if (content) {
                accumulatedContent += content

                // Stream the content word by word
                const contentMessage = `data: ${JSON.stringify({
                    type: 'content',
                    content: content,
                    source: 'internet', // Voice chat uses internet-based responses
                    sources: [] // Will be populated in complete message
                })}\n\n`
                try {
                    controller.enqueue(encoder.encode(contentMessage))
                } catch (controllerError) {
                    console.log('🎤 Controller closed, stopping stream')
                    break
                }
            }

            // Force completion after max chunks to prevent long processing
            if (chunkCount >= maxChunks) {
                console.log('🎤 Max chunks reached, forcing completion')
                break
            }
        }

        // Send success message for voice chat
        const successMessage = `data: ${JSON.stringify({ type: 'status', status: 'completed', message: '✅ Voice response completed successfully!' })}\n\n`
        try {
            controller.enqueue(encoder.encode(successMessage))
            console.log('✅ Voice chat success message sent')
        } catch (controllerError) {
            console.log('🎤 Could not send voice chat success message')
        }

        // Detect sources in the response
        const sourceInfo = detectInternetBasedContent(accumulatedContent)

        // Send complete signal
        const completeMessage = `data: ${JSON.stringify({
            type: 'complete',
            content: accumulatedContent,
            source: 'internet', // Voice chat uses internet-based responses
            sources: sourceInfo.sources // Include actual source URLs/names
        })}\n\n`
        try {
            controller.enqueue(encoder.encode(completeMessage))
            // Don't close controller here - let the main ReadableStream handle it
        } catch (controllerError) {
            console.log('🎤 Controller already closed')
        }

        console.log('🎤 Voice chat completed with content length:', accumulatedContent.length)

    } catch (error) {
        console.error('❌ Voice chat error:', error)
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to process voice chat request' })}\n\n`
        try {
            controller.enqueue(encoder.encode(errorMessage))
        } catch (controllerError) {
            console.log('🎤 Controller closed, cannot send error message')
        }
    }
}

// Streaming response handler
async function handleStreamingResponse(message: string, voiceChat: boolean = false, sessionId?: string, conversationHistory: any[] = []) {
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
        async start(controller) {
            // Declare timeout variable in outer scope
            let timeoutId: NodeJS.Timeout | null = null

            try {
                console.log('🔄 Starting streaming response for:', message)
                console.log('🔄 Conversation history length:', conversationHistory.length)

                // Send initial status message
                const initialMessage = `data: ${JSON.stringify({ type: 'status', status: 'starting', message: 'AI is processing your request. Taking time to provide you with a comprehensive and accurate answer...' })}\n\n`
                try {
                    controller.enqueue(encoder.encode(initialMessage))
                } catch (error) {
                    console.log('Controller closed during initial message')
                    return
                }

                // Set up intelligent timeout to complete response before Vercel closes connection
                timeoutId = setTimeout(async () => {
                    console.log('⏰ 8-second mark reached - intelligently completing response to beat Vercel timeout')

                    try {
                        // Try to get whatever response the AI has generated so far
                        if (threadId) {
                            try {
                                const messages = await openai.beta.threads.messages.list(threadId)
                                const assistantMessages = messages.data.filter(msg => msg.role === 'assistant')

                                if (assistantMessages.length > 0) {
                                    const latestMessage = assistantMessages[0]
                                    if (latestMessage.content && latestMessage.content.length > 0) {
                                        const content = latestMessage.content[0]
                                        if (content.type === 'text') {
                                            const responseText = content.text.value
                                            console.log('✅ Got partial AI response for forced completion:', responseText.substring(0, 100) + '...')

                                            // Send the partial response as content
                                            const contentMessage = `data: ${JSON.stringify({
                                                type: 'content',
                                                content: responseText,
                                                source: 'partial_response'
                                            })}\n\n`
                                            controller.enqueue(encoder.encode(contentMessage))

                                            // Send completion signal with the actual content
                                            const forceCompleteMessage = `data: ${JSON.stringify({
                                                type: 'complete',
                                                content: responseText,
                                                source: 'partial_response'
                                            })}\n\n`
                                            controller.enqueue(encoder.encode(forceCompleteMessage))
                                            console.log('✅ Intelligent forced completion with actual AI response')
                                            return
                                        }
                                    }
                                }
                            } catch (error) {
                                console.log('❌ Could not retrieve partial response:', error)
                            }
                        }

                        // No partial response available - send status update instead of completion
                        console.log('⚠️ No partial response available - sending status update to keep progress visible')

                        // Send status update to keep progress card visible
                        const statusUpdateMessage = `data: ${JSON.stringify({
                            type: 'status',
                            status: 'processing',
                            message: '⏳ Still processing your request... Please wait a moment longer.'
                        })}\n\n`
                        controller.enqueue(encoder.encode(statusUpdateMessage))

                        // Don't send completion yet - let the natural flow continue
                        console.log('✅ Status update sent - progress card remains visible')
                    } catch (error) {
                        console.log('❌ Could not send intelligent timeout handling')
                    }
                }, 8000) // 8 seconds - intelligent timeout handling to beat Vercel's 30-second limit

                // Step 1: Get or create thread based on session
                let threadId: string
                if (sessionId && activeThreads.has(sessionId)) {
                    // Use existing thread for conversation continuity
                    threadId = activeThreads.get(sessionId)!
                    console.log('🔄 Using existing thread:', threadId)

                    // Check if there are any runs in progress and wait for them to complete
                    try {
                        const runs = await openai.beta.threads.runs.list(threadId)
                        const activeRuns = runs.data.filter(run =>
                            run.status === 'queued' || run.status === 'in_progress' || run.status === 'requires_action'
                        )

                        if (activeRuns.length > 0) {
                            console.log(`⏳ Found ${activeRuns.length} active runs, waiting for completion...`)
                            for (const activeRun of activeRuns) {
                                console.log(`⏳ Waiting for run ${activeRun.id} (status: ${activeRun.status}) to complete...`)

                                // If run requires action, we need to handle it
                                if (activeRun.status === 'requires_action') {
                                    console.log('🔧 Run requires action, handling it...')
                                    // For now, just wait for it to complete - the main flow will handle it
                                    console.log('⏳ Waiting for requires_action run to complete...')
                                } else {
                                    // Wait for other runs to complete
                                    let runStatus: any = activeRun.status
                                    let attempts = 0
                                    const maxAttempts = 20 // Reduced to 20 seconds to complete before Vercel closes

                                    while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
                                        await new Promise(resolve => setTimeout(resolve, 1000))
                                        try {
                                            const runResult = await openai.beta.threads.runs.retrieve(activeRun.id, { thread_id: threadId })
                                            runStatus = runResult.status
                                            attempts++
                                            console.log(`⏳ Active run status: ${runStatus} (attempt ${attempts}/${maxAttempts})`)

                                            if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'requires_action') {
                                                break
                                            }
                                        } catch (error) {
                                            console.error('❌ Error checking active run status:', error)
                                            break
                                        }
                                    }
                                }
                            }
                            console.log('✅ All active runs completed')
                        }
                    } catch (error) {
                        console.error('❌ Error checking active runs:', error)
                        // Continue anyway, don't fail the request
                    }
                } else {
                    // Create new thread for new conversation
                    const thread = await openai.beta.threads.create()
                    threadId = thread.id
                    if (sessionId) {
                        activeThreads.set(sessionId, threadId)
                    }
                    console.log('✅ New thread created:', threadId)
                }

                // Step 2: Handle voice chat differently - use direct chat completion
                if (voiceChat) {
                    console.log('🎤 Using direct chat completion for voice chat with history length:', conversationHistory.length)
                    await handleVoiceChatDirect(message, conversationHistory, controller, encoder)
                    // Voice chat handles its own controller lifecycle
                } else {
                    // Add current message to thread (OpenAI manages history automatically)
                    await openai.beta.threads.messages.create(threadId, {
                        role: 'user',
                        content: message
                    })
                    console.log('✅ Message added to thread')

                    // Step 3: Create run with the assistant (optimized for speed)
                    const run = await openai.beta.threads.runs.create(threadId, {
                        assistant_id: ASSISTANT_ID,
                        instructions: `You are a stamp expert assistant with access to a comprehensive stamp database. Follow these CRITICAL rules:

**KNOWLEDGE BASE USAGE:**
- ONLY use the return_stamp_data function when you have SPECIFIC stamp information from the database
- NEVER create fake or dummy stamp data
- NEVER invent stamp IDs, names, or details
- If you don't have specific stamp data, say "I don't have specific information about that stamp in my database" and provide general philatelic knowledge instead

**FUNCTION CALL RULES:**
- ONLY call return_stamp_data when you have REAL stamp data from the database
- The function requires COMPLETE stamp information: name, country, year, denomination, color, etc.
- NEVER call the function with just IDs or partial data
- If you can't provide complete stamp details, DON'T call the function

**WHEN NO STAMP DATA EXISTS:**
- Honestly say "I don't have specific information about that stamp in my database"
- Provide general philatelic knowledge about the topic
- Explain stamp collecting principles, history, or general information
- NEVER make up or guess stamp details

**INTERNET SOURCES:**
- Only mention internet sources if you're providing current market data, recent news, or information not in the database
- Include actual URLs when referencing internet sources
- Be honest about what you know vs. what you're finding online

**RESPONSE QUALITY:**
- Focus on accuracy over completeness
- If you don't know something, say so
- Provide helpful, educational content about stamps and philately
- Take time to give comprehensive, accurate answers
- NEVER repeat yourself or use repetitive phrases
- Be concise and direct - avoid verbose explanations
- If you don't have specific data, provide brief, helpful guidance

Remember: It's better to say "I don't have specific data about that stamp" than to provide false information.`
                    })
                    console.log('✅ Run created:', run.id)

                    // Send progress status to show AI is working
                    const progressMessage = `data: ${JSON.stringify({
                        type: 'status',
                        status: 'processing',
                        message: '🤖 AI is analyzing your stamp question and searching the database...'
                    })}\n\n`
                    try {
                        controller.enqueue(encoder.encode(progressMessage))
                    } catch (error) {
                        console.log('Controller closed during progress message')
                    }

                    // Send additional status to keep progress card visible
                    setTimeout(() => {
                        try {
                            const keepAliveMessage = `data: ${JSON.stringify({
                                type: 'status',
                                status: 'processing',
                                message: '🔍 Continuing to search and analyze stamp information...'
                            })}\n\n`
                            controller.enqueue(encoder.encode(keepAliveMessage))
                        } catch (error) {
                            console.log('Controller closed during keep-alive message')
                        }
                    }, 3000) // Send keep-alive after 3 seconds

                    // Send another status update to maintain progress visibility
                    setTimeout(() => {
                        try {
                            const progressUpdateMessage = `data: ${JSON.stringify({
                                type: 'status',
                                status: 'processing',
                                message: '📊 Analyzing stamp data and preparing comprehensive response...'
                            })}\n\n`
                            controller.enqueue(encoder.encode(progressUpdateMessage))
                        } catch (error) {
                            console.log('Controller closed during progress update message')
                        }
                    }, 5000) // Send progress update after 5 seconds

                    // Step 4: Stream the response (agent handles source selection)
                    await streamRunResponse(threadId, run.id, controller, encoder)
                    // Don't close controller here - streamRunResponse handles it
                }

                // Clear the timeout since we completed successfully
                if (timeoutId) {
                    clearTimeout(timeoutId)
                }

                // Send success completion message immediately after streaming
                const successMessage = `data: ${JSON.stringify({ type: 'status', status: 'completed', message: '✅ AI response completed successfully!' })}\n\n`
                try {
                    controller.enqueue(encoder.encode(successMessage))
                    console.log('✅ Success message sent successfully')
                } catch (error) {
                    console.log('Could not send success message, controller may be closed')
                }

                // Send final status to ensure progress card shows completion
                const finalStatusMessage = `data: ${JSON.stringify({
                    type: 'status',
                    status: 'processing',
                    message: '✅ Response ready! Displaying results...'
                })}\n\n`
                try {
                    controller.enqueue(encoder.encode(finalStatusMessage))
                    console.log('✅ Final status message sent')
                } catch (error) {
                    console.log('Could not send final status message')
                }

                // Send a brief delay before completion to ensure status is visible
                setTimeout(() => {
                    try {
                        const readyMessage = `data: ${JSON.stringify({
                            type: 'status',
                            status: 'processing',
                            message: '🎯 Finalizing response...'
                        })}\n\n`
                        controller.enqueue(encoder.encode(readyMessage))
                        console.log('✅ Ready message sent')
                    } catch (error) {
                        console.log('Could not send ready message')
                    }
                }, 500)

                // Send final status to show response is ready
                setTimeout(() => {
                    try {
                        const finalReadyMessage = `data: ${JSON.stringify({
                            type: 'status',
                            status: 'processing',
                            message: '✨ Response ready! Check above for results.'
                        })}\n\n`
                        controller.enqueue(encoder.encode(finalReadyMessage))
                        console.log('✅ Final ready message sent')
                    } catch (error) {
                        console.log('Could not send final ready message')
                    }
                }, 1000)

                // Send one more status to ensure smooth transition
                setTimeout(() => {
                    try {
                        const transitionMessage = `data: ${JSON.stringify({
                            type: 'status',
                            status: 'processing',
                            message: '🚀 Preparing to display your stamp information...'
                        })}\n\n`
                        controller.enqueue(encoder.encode(transitionMessage))
                        console.log('✅ Transition message sent')
                    } catch (error) {
                        console.log('Could not send transition message')
                    }
                }, 1500)

                // Add final safety timeout to force completion before Vercel closes
                setTimeout(() => {
                    try {
                        // Only send completion if we haven't already
                        const finalCompleteMessage = `data: ${JSON.stringify({
                            type: 'complete',
                            content: '',
                            source: 'knowledge_base'
                        })}\n\n`
                        controller.enqueue(encoder.encode(finalCompleteMessage))
                        console.log('✅ Final safety completion message sent')
                    } catch (error) {
                        console.log('❌ Could not send final safety completion message')
                    }
                }, 500) // Send final message 500ms after success

                // Log completion status
                console.log('🔒 All streaming complete, controller state:', controller.desiredSize)
                console.log('🔒 Success message sent, controller will close naturally')

            } catch (error) {
                console.error('❌ Streaming error:', error)

                // Clear the timeout since we're handling the error
                if (timeoutId) {
                    clearTimeout(timeoutId)
                }

                // Send user-friendly error message
                const errorMessage = `data: ${JSON.stringify({ type: 'status', status: 'error', message: '❌ Something went wrong while processing your request. Please try again with a simpler question.' })}\n\n`
                try {
                    controller.enqueue(encoder.encode(errorMessage))
                    console.log('✅ User-friendly error message sent successfully')
                } catch (controllerError) {
                    console.log('Controller closed, cannot send error message')
                }

                // Try to send a completion signal to prevent hanging
                try {
                    const completeMessage = `data: ${JSON.stringify({ type: 'complete', error: true })}\n\n`
                    controller.enqueue(encoder.encode(completeMessage))
                    console.log('✅ Completion signal sent after error')
                } catch (finalError) {
                    console.log('Could not send completion signal after error')
                }

                // Don't close controller here - let the natural flow handle it
            }
        }
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Keep-Alive': 'timeout=30, max=1000',
        },
    })
}



// Stream run response (original function - kept for compatibility)
async function streamRunResponse(threadId: string, runId: string, controller: ReadableStreamDefaultController, encoder: TextEncoder) {
    let runStatus = 'queued'
    let attempts = 0
    const maxAttempts = 8 // Reduced to 8 seconds to complete before Vercel closes connection

    try {
        while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
            console.log(`⏳ Run status: ${runStatus} (attempt ${attempts + 1}/${maxAttempts})`)

            // Send status update
            const statusMessage = `data: ${JSON.stringify({ type: 'status', status: runStatus })}\n\n`
            try {
                controller.enqueue(encoder.encode(statusMessage))
            } catch (error) {
                console.log('Controller closed during status update, stopping')
                // Send a final error message if possible
                try {
                    const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Connection lost during processing. Please try again.' })}\n\n`
                    controller.enqueue(encoder.encode(errorMessage))
                } catch (finalError) {
                    console.log('Could not send final error message')
                }
                return
            }

            // Send keep-alive signal every 5 seconds to prevent idle timeout
            if (attempts % 5 === 0) {
                const keepAliveMessage = `data: ${JSON.stringify({ type: 'keep-alive', timestamp: Date.now() })}\n\n`
                try {
                    controller.enqueue(encoder.encode(keepAliveMessage))
                } catch (error) {
                    console.log('Keep-alive signal failed, connection may be closed')
                    break
                }
            }

            // Send optimization hint when approaching the limit
            if (attempts === 5) { // Hint at 5 seconds (3 seconds before timeout)
                const warningMessage = `data: ${JSON.stringify({ type: 'warning', message: '💡 Still processing your request... Completing your response now.' })}\n\n`
                try {
                    controller.enqueue(encoder.encode(warningMessage))
                } catch (error) {
                    console.log('Warning message failed, connection may be closed')
                    break
                }
            }

            await new Promise(resolve => setTimeout(resolve, 500)) // Reduced from 1000ms to 500ms for faster response

            try {
                const runResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId })
                runStatus = runResult.status
                attempts++

                if (runResult.last_error) {
                    console.error('❌ Run error:', runResult.last_error)
                    const errorMessage = `data: ${JSON.stringify({ type: 'error', error: runResult.last_error })}\n\n`
                    try {
                        controller.enqueue(encoder.encode(errorMessage))
                    } catch (error) {
                        console.log('Controller closed during error message, stopping')
                        return
                    }
                    return
                }
            } catch (error) {
                console.error('❌ Error checking run status:', error)
                break
            }
        }

        console.log(`✅ Run completed with status: ${runStatus} after ${attempts} attempts (${attempts} seconds)`)

        // Handle different run statuses
        if (runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'expired') {
            const errorMessage = `data: ${JSON.stringify({ type: 'error', error: `Run ${runStatus}` })}\n\n`
            try {
                controller.enqueue(encoder.encode(errorMessage))
            } catch (error) {
                console.log('Controller closed during error message, stopping')
                return
            }
            return
        }

        if (runStatus === 'queued' || runStatus === 'in_progress') {
            console.log(`⏰ Run timed out after ${attempts} attempts with status: ${runStatus}`)

            // Instead of timing out, try to get whatever response we can from the current run
            console.log('🔄 Run still in progress, attempting to get partial response...')

            try {
                // Try to get messages from the current run even if it's not complete
                const messages = await openai.beta.threads.messages.list(threadId)
                const assistantMessages = messages.data.filter(msg => msg.role === 'assistant')

                if (assistantMessages.length > 0) {
                    const latestMessage = assistantMessages[0]
                    if (latestMessage.content && latestMessage.content.length > 0) {
                        const content = latestMessage.content[0]
                        if (content.type === 'text') {
                            const responseText = content.text.value
                            console.log('✅ Got partial response from incomplete run:', responseText.substring(0, 100) + '...')

                            // Send the partial response
                            const partialResponseMessage = `data: ${JSON.stringify({
                                type: 'content',
                                content: responseText,
                                source: 'knowledge_base'
                            })}\n\n`
                            controller.enqueue(encoder.encode(partialResponseMessage))

                            // Send completion signal
                            const completeMessage = `data: ${JSON.stringify({
                                type: 'complete',
                                content: responseText,
                                source: 'knowledge_base'
                            })}\n\n`
                            controller.enqueue(encoder.encode(completeMessage))

                            console.log('✅ Partial response sent successfully')
                            return
                        }
                    }
                }

                // If we couldn't get a partial response, send a helpful message
                const helpfulMessage = `data: ${JSON.stringify({
                    type: 'content',
                    content: "I'm still processing your stamp question. The response is taking longer than expected. Please try asking a more specific question about stamps, or wait a moment for the complete response.",
                    source: 'knowledge_base'
                })}\n\n`
                controller.enqueue(encoder.encode(helpfulMessage))

                const completeMessage = `data: ${JSON.stringify({
                    type: 'complete',
                    content: "I'm working on your request about stamps. While I'm processing, here's what I can tell you: Stamp collecting is a fascinating hobby that combines history, art, and geography. Each stamp tells a unique story about its country of origin and the era it was issued. Would you like me to continue with more specific information about your query?",
                    source: 'knowledge_base'
                })}\n\n`
                controller.enqueue(encoder.encode(completeMessage))

                console.log('✅ Helpful fallback response sent')

            } catch (error) {
                console.error('❌ Error getting partial response:', error)
                // Send a simple completion message
                const simpleMessage = `data: ${JSON.stringify({
                    type: 'complete',
                    content: "I'm here to help with your stamp questions! Please ask me anything about stamps, and I'll provide you with detailed information.",
                    source: 'knowledge_base'
                })}\n\n`
                try {
                    controller.enqueue(encoder.encode(simpleMessage))
                } catch (finalError) {
                    console.log('Could not send simple completion message')
                }
            }
            return
        }

        // Handle requires_action (function calls)
        if (runStatus === 'requires_action') {
            console.log('🔧 Run requires action - handling function calls...')

            // Send progress status to show AI is working
            const progressMessage = `data: ${JSON.stringify({
                type: 'status',
                status: 'processing',
                message: '🔍 AI is searching the stamp database for your query...'
            })}\n\n`
            try {
                controller.enqueue(encoder.encode(progressMessage))
            } catch (error) {
                console.log('Controller closed during progress message')
            }

            // Send additional status to keep progress card visible during function processing
            setTimeout(() => {
                try {
                    const keepAliveMessage = `data: ${JSON.stringify({
                        type: 'status',
                        status: 'processing',
                        message: '📊 Processing stamp data and preparing response...'
                    })}\n\n`
                    controller.enqueue(encoder.encode(keepAliveMessage))
                } catch (error) {
                    console.log('Controller closed during function processing keep-alive')
                }
            }, 2000) // Send keep-alive after 2 seconds

            // Send another status update to maintain progress visibility
            setTimeout(() => {
                try {
                    const progressUpdateMessage = `data: ${JSON.stringify({
                        type: 'status',
                        status: 'processing',
                        message: '🔍 Searching stamp database and compiling results...'
                    })}\n\n`
                    controller.enqueue(encoder.encode(progressUpdateMessage))
                } catch (error) {
                    console.log('Controller closed during function processing progress update')
                }
            }, 4000) // Send progress update after 4 seconds

            const runResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId })
            console.log('📊 Run result:', runResult)

            if (runResult.required_action && runResult.required_action.type === 'submit_tool_outputs') {
                console.log('🔧 Found tool outputs to submit')

                const toolCalls = runResult.required_action.submit_tool_outputs.tool_calls
                console.log('🔧 Tool calls found:', toolCalls.length)

                const toolOutputs = []
                let stamps = []
                let structuredData = null

                for (const toolCall of toolCalls) {
                    console.log('🔧 Processing tool call:', toolCall)
                    if (toolCall.function.name === 'return_stamp_data') {
                        try {
                            const functionArgs = JSON.parse(toolCall.function.arguments)
                            console.log('📊 Function call data:', functionArgs)

                            if (functionArgs.stamps && Array.isArray(functionArgs.stamps)) {
                                // VALIDATE: Check if stamps have real data, not just IDs
                                const validStamps = functionArgs.stamps.filter((s: any) => {
                                    // Must have at least name, country, and year - not just ID
                                    const hasValidData = s.Name || s.name || s.Country || s.country || s.IssueYear || s.issueYear || s.issue_year
                                    if (!hasValidData) {
                                        console.log('🚨 INVALID STAMP DATA DETECTED - Only ID provided:', s)
                                        return false
                                    }
                                    return true
                                })

                                if (validStamps.length === 0) {
                                    console.log('🚨 ALL STAMP DATA INVALID - Providing fallback response')

                                    // Send a helpful message instead of error
                                    const helpfulMessage = `data: ${JSON.stringify({
                                        type: 'content',
                                        content: "I'm working on your stamp question. While I don't have specific catalog data for that query, let me provide you with some helpful philatelic information instead.",
                                        source: 'knowledge_base'
                                    })}\n\n`
                                    try {
                                        controller.enqueue(encoder.encode(helpfulMessage))
                                    } catch (error) {
                                        console.log('Controller closed during helpful message')
                                    }

                                    // Send completion signal to show the response
                                    const completeMessage = `data: ${JSON.stringify({
                                        type: 'complete',
                                        content: "I don't have specific catalog data for that query. Would you like me to help you with a different stamp question or provide general philatelic guidance?",
                                        source: 'knowledge_base'
                                    })}\n\n`
                                    try {
                                        controller.enqueue(encoder.encode(completeMessage))
                                    } catch (error) {
                                        console.log('Controller closed during completion message')
                                    }

                                    return
                                }

                                stamps = validStamps
                                structuredData = functionArgs
                                console.log(`✅ Found ${stamps.length} VALID stamps from function call`)
                                console.log('📋 Valid stamp details:', stamps.map((s: any) => ({
                                    name: s.Name || s.name || 'Unknown',
                                    country: s.Country || s.country || 'Unknown',
                                    year: s.IssueYear || s.issueYear || s.issue_year || 'Unknown'
                                })))

                                // Send stamp preview immediately
                                const stampPreview = {
                                    count: stamps.length,
                                    stamps: stamps.slice(0, 5).map((s: any) => ({
                                        name: s.Name || 'Unknown',
                                        country: s.Country || 'Unknown',
                                        year: s.IssueYear || 'Unknown',
                                        denomination: `${s.DenominationValue || ''}${s.DenominationSymbol || ''}`,
                                        color: s.Color || 'Unknown'
                                    }))
                                }

                                const previewMessage = `data: ${JSON.stringify({ type: 'stamp_preview', data: stampPreview })}\n\n`
                                try {
                                    controller.enqueue(encoder.encode(previewMessage))
                                } catch (error) {
                                    console.log('Controller closed during preview message, stopping')
                                    return
                                }

                                // Also send raw stamp data for voice chat
                                const rawStampData = {
                                    count: stamps.length,
                                    stamps: stamps.slice(0, 5) // Send the raw stamp objects
                                }

                                console.log('📤 Sending raw stamp data for voice chat:', rawStampData)
                                const rawDataMessage = `data: ${JSON.stringify({ type: 'raw_stamp_data', data: rawStampData })}\n\n`
                                try {
                                    controller.enqueue(encoder.encode(rawDataMessage))
                                } catch (error) {
                                    console.log('Controller closed during raw data message, stopping')
                                    return
                                }
                            } else {
                                console.log('⚠️ No stamps array found in function call data')
                            }
                        } catch (error) {
                            console.log('❌ Error parsing function arguments:', error)
                        }
                    }

                    toolOutputs.push({
                        tool_call_id: toolCall.id,
                        output: JSON.stringify({
                            success: true,
                            stamps: stamps,
                            instructions: "🚨 CRITICAL INSTRUCTIONS - YOU MUST FOLLOW THESE EXACTLY: ❌ NEVER list basic stamp details like Country, Issue Date, Catalog Code, Denomination, Color, or Paper Type. These are already displayed in the card above. ✅ INSTEAD, write ONLY about: Historical significance, design elements, cultural importance, interesting stories, collecting insights, philatelic significance, and series context. Focus on the STORY behind the stamp, not repeating the data. Example: 'This stamp captures the dynamic beauty of New Zealand's native trout in a stunning artistic composition that celebrates the country's freshwater fishing heritage.' NOT 'Country: New Zealand, Issue Date: May 4, 1935, Color: Blue' 🚨 IMPORTANT: ONLY use REAL stamp data from the database. NEVER invent or hallucinate stamp information. If you don't have real data, say so honestly."
                        })
                    })
                }

                // Create structured data immediately from function call
                let immediateStructuredData = null
                if (stamps.length === 1) {
                    console.log('🎴 Creating single stamp card with data:', stamps[0])
                    immediateStructuredData = generateStampCard(stamps[0])
                    console.log('🎴 Generated card data:', immediateStructuredData)
                } else if (stamps.length > 1) {
                    console.log(`🎠 Creating carousel with ${stamps.length} stamps`)
                    immediateStructuredData = generateStampCarousel(stamps.slice(0, 5))
                    console.log('🎠 Generated carousel data:', immediateStructuredData)
                } else {
                    console.log('⚠️ No stamps found in function call data')
                }

                // Send structured data
                if (immediateStructuredData) {
                    console.log('📤 Sending structured data to frontend:', immediateStructuredData.type)
                    const structuredMessage = `data: ${JSON.stringify({ type: 'structured_data', data: immediateStructuredData })}\n\n`
                    try {
                        controller.enqueue(encoder.encode(structuredMessage))
                    } catch (error) {
                        console.log('Controller closed during structured data message, stopping')
                        return
                    }
                } else {
                    console.log('⚠️ No structured data to send')
                }

                // Let the AI assistant generate the proper response instead of hardcoded text
                // The AI will provide contextual, complementary information about the stamps

                // CRITICAL: Submit tool outputs back to the thread to complete the conversation
                if (toolOutputs.length > 0) {
                    try {
                        console.log('📤 Submitting tool outputs back to thread:', toolOutputs.length, 'outputs')
                        await openai.beta.threads.runs.submitToolOutputs(runId, {
                            thread_id: threadId,
                            tool_outputs: toolOutputs
                        })
                        console.log('✅ Tool outputs submitted successfully')

                        // Wait for the run to complete after submitting tool outputs
                        console.log('⏳ Waiting for run to complete after tool output submission...')
                        let finalRunStatus = 'in_progress'
                        let finalAttempts = 0
                        const maxFinalAttempts = 10 // Wait up to 10 seconds for completion

                        while (finalRunStatus === 'in_progress' && finalAttempts < maxFinalAttempts) {
                            await new Promise(resolve => setTimeout(resolve, 1000))
                            try {
                                const finalRunResult = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId })
                                finalRunStatus = finalRunResult.status
                                finalAttempts++
                                console.log(`⏳ Final run status: ${finalRunStatus} (attempt ${finalAttempts}/${maxFinalAttempts})`)

                                if (finalRunStatus === 'completed') {
                                    console.log('✅ Run completed successfully after tool output submission')
                                    break
                                } else if (finalRunStatus === 'failed' || finalRunStatus === 'cancelled') {
                                    console.log(`❌ Run ${finalRunStatus} after tool output submission`)
                                    break
                                }
                            } catch (error) {
                                console.error('❌ Error checking final run status:', error)
                                break
                            }
                        }

                        // If the run completed, stream the final response
                        if (finalRunStatus === 'completed') {
                            console.log('📤 Streaming final response after tool output submission')
                            console.log('📤 Controller state before calling streamMessages:', controller.desiredSize)
                            await streamMessages(threadId, controller, encoder)
                            console.log('✅ Final response streamed, exiting early')
                            console.log('📤 streamMessages completed, controller state:', controller.desiredSize)
                            // Don't return early - let the main flow handle completion
                            // This ensures the controller isn't closed prematurely
                        }

                    } catch (submitError) {
                        console.error('❌ Error submitting tool outputs:', submitError)
                        // Don't fail the request, but log the error
                    }
                }

                return
            }
        }

        // Get the messages and stream the response (only if we didn't handle it above)
        if (runStatus === 'completed') {
            console.log('📤 Streaming response for completed run (no tool outputs)')
            console.log('📤 Controller state before calling streamMessages:', controller.desiredSize)
            await streamMessages(threadId, controller, encoder)
            console.log('📤 streamMessages completed, controller state:', controller.desiredSize)
        } else {
            console.log(`📤 Run ended with status: ${runStatus}, no response to stream`)
        }
        // Note: streamMessages will handle closing the controller

    } catch (error) {
        console.error('❌ Error in streamRunResponse:', error)
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to process request' })}\n\n`
        try {
            controller.enqueue(encoder.encode(errorMessage))
        } catch (controllerError) {
            console.log('Controller closed during error message, stopping')
            return
        }
    }
}

// Stream messages from thread
async function streamMessages(threadId: string, controller: ReadableStreamDefaultController, encoder: TextEncoder) {
    try {
        console.log('📤 Starting streamMessages with controller state:', controller.desiredSize)

        const messages = await openai.beta.threads.messages.list(threadId)
        const assistantMessages = messages.data.filter(msg => msg.role === 'assistant')

        if (assistantMessages.length > 0) {
            const latestMessage = assistantMessages[0]

            if (latestMessage.content.length > 0) {
                const content = latestMessage.content[0]

                if (content.type === 'text') {
                    const text = content.text.value
                    const cleanedText = cleanResponseText(text)
                    console.log('📝 Streaming text content, length:', cleanedText.length)

                    // Detect if response contains internet-based information and extract sources
                    const sourceInfo = detectInternetBasedContent(cleanedText)
                    const responseSource = sourceInfo.isInternetBased ? 'internet' : 'knowledge_base'
                    console.log(`🔍 Response source detected: ${responseSource}`)
                    if (sourceInfo.sources.length > 0) {
                        console.log(`🔍 Sources found: ${sourceInfo.sources.join(', ')}`)
                    }

                    // BULLETPROOF: Send complete response immediately to prevent any loss
                    const completeResponseMessage = `data: ${JSON.stringify({
                        type: 'complete_response',
                        content: cleanedText,
                        source: responseSource, // Use detected source
                        sources: sourceInfo.sources // Include actual source URLs/names
                    })}\n\n`
                    try {
                        controller.enqueue(encoder.encode(completeResponseMessage))
                        console.log('✅ Complete response sent immediately to prevent loss')
                    } catch (completeError) {
                        console.log('❌ Could not send complete response')
                    }

                    // Send initial connection establishment signal
                    const connectionMessage = `data: ${JSON.stringify({ type: 'connection', status: 'established', contentLength: cleanedText.length })}\n\n`
                    try {
                        controller.enqueue(encoder.encode(connectionMessage))
                        console.log('🔗 Connection established signal sent')
                    } catch (connectionError) {
                        console.log('❌ Connection signal failed')
                    }

                    // Buffer the complete response in case streaming gets interrupted
                    let completeResponse = ''
                    let streamedWords = 0
                    const totalWords = cleanedText.split(' ').length

                    // Stream the text in larger chunks to reduce interruption risk
                    const words = cleanedText.split(' ')
                    const chunkSize = 5 // Send 5 words at a time instead of 1

                    for (let i = 0; i < words.length; i += chunkSize) {
                        const chunk = words.slice(i, i + chunkSize)
                        const chunkText = chunk.join(' ')
                        const message = `data: ${JSON.stringify({
                            type: 'content',
                            content: chunkText + (i + chunkSize < words.length ? ' ' : ''),
                            source: responseSource, // Use detected source
                            sources: sourceInfo.sources // Include actual source URLs/names
                        })}\n\n`

                        // BULLETPROOF: Check controller state before every operation
                        if (controller.desiredSize === null) {
                            console.log('⚠️ Controller closed during streaming, stopping content stream at word', i)
                            console.log('📤 Complete response already sent at start - no content loss')
                            return
                        }

                        try {
                            controller.enqueue(encoder.encode(message))
                            streamedWords = Math.min(i + chunkSize, words.length)
                            completeResponse += chunkText + (i + chunkSize < words.length ? ' ' : '')
                            console.log(`📤 Streamed chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(words.length / chunkSize)}: "${chunkText}" (words ${i + 1}-${streamedWords})`)

                            // Send keep-alive signal every 3 chunks to prevent timeout
                            if (Math.floor(i / chunkSize) % 3 === 0 && i > 0) {
                                const keepAliveMessage = `data: ${JSON.stringify({ type: 'keep-alive', chunk: Math.floor(i / chunkSize), total: Math.ceil(words.length / chunkSize) })}\n\n`
                                try {
                                    controller.enqueue(encoder.encode(keepAliveMessage))
                                    console.log(`📡 Keep-alive signal sent at chunk ${Math.floor(i / chunkSize)}`)
                                } catch (keepAliveError) {
                                    console.log('❌ Keep-alive signal failed')
                                }
                            }
                        } catch (error) {
                            console.log('❌ Controller closed during content streaming, stopping at word', i)
                            console.log('📤 Complete response already sent at start - no content loss')
                            return
                        }

                        // Reduced delay for faster chunked streaming
                        await new Promise(resolve => setTimeout(resolve, 50))
                    }

                    console.log('✅ Content streaming completed successfully')

                    // Send success message immediately after content streaming
                    const successMessage = `data: ${JSON.stringify({ type: 'status', status: 'completed', message: '✅ AI response completed successfully!' })}\n\n`
                    try {
                        controller.enqueue(encoder.encode(successMessage))
                        console.log('✅ Success message sent immediately after content streaming')
                    } catch (error) {
                        console.log('❌ Could not send success message after content streaming')
                    }

                    // Send completion signal only if controller is still open
                    if (controller.desiredSize !== null) {
                        const completeMessage = `data: ${JSON.stringify({ type: 'complete' })}\n\n`
                        try {
                            controller.enqueue(encoder.encode(completeMessage))
                            console.log('✅ Completion signal sent successfully')
                        } catch (error) {
                            console.log('❌ Controller closed during completion message')
                            return
                        }
                    } else {
                        console.log('⚠️ Controller already closed, skipping completion message')
                    }
                } else {
                    console.log('⚠️ No text content found in message')
                }
            } else {
                console.log('⚠️ No content found in assistant message')
            }
        } else {
            console.log('⚠️ No assistant messages found')
        }
    } catch (error) {
        console.error('❌ Error streaming messages:', error)
        const errorMessage = `data: ${JSON.stringify({ type: 'error', error: 'Failed to get response' })}\n\n`

        // BULLETPROOF: Check controller state before sending error message
        if (controller.desiredSize !== null) {
            try {
                controller.enqueue(encoder.encode(errorMessage))
                console.log('✅ Error message sent successfully')
            } catch (controllerError) {
                console.log('❌ Controller closed during error message')
                return
            }
        } else {
            console.log('⚠️ Controller already closed, cannot send error message')
        }
    }

    console.log('📤 streamMessages function completed, controller state:', controller.desiredSize)
}

// Generate card format for single stamp
function generateStampCard(stamp: any) {
    // Map the vector store fields to card display format
    const year = stamp.issueYear || stamp.IssueYear || (stamp.issueDate ? stamp.issueDate.split('-')[0] : stamp.IssueDate ? stamp.IssueDate.split('-')[0] : 'Unknown')
    // Use denominationSymbol if available, otherwise construct from denominationValue
    const denomination = stamp.denominationSymbol || stamp.DenominationSymbol || `${stamp.denominationValue || stamp.DenominationValue}`
    const subtitle = `${stamp.country || stamp.Country} • ${year} • ${denomination}`

    // Handle different possible image URL field names
    const imageUrl = stamp.stampImageUrl || stamp.StampImageUrl || stamp.image || stamp.StampImage || '/images/stamps/no-image-available.png'

    return {
        type: 'card',
        id: stamp.id || stamp.Id, // Use lowercase 'id' first, then fallback to 'Id'
        title: stamp.name || stamp.Name || stamp.catalogNumber || stamp.StampCatalogCode || 'Stamp',
        subtitle: subtitle,
        image: imageUrl,
        content: [
            {
                section: 'Overview',
                text: `${stamp.name || stamp.Name} from ${stamp.country || stamp.Country}, issued in ${year}. Denomination: ${denomination}. Color: ${stamp.color || stamp.Color || 'Unknown'}.`
            },
            {
                section: 'Details',
                details: [
                    { label: 'Catalog Code', value: stamp.catalogNumber || stamp.StampCatalogCode || 'N/A' },
                    { label: 'Issue Date', value: stamp.issueDate || stamp.IssueDate || 'N/A' },
                    { label: 'Color', value: stamp.color || stamp.Color || 'N/A' },
                    { label: 'Paper Type', value: stamp.paperType || stamp.PaperType || 'N/A' }
                ]
            }
        ],
        significance: `A ${stamp.color || stamp.Color || 'colorful'} stamp from ${stamp.country || stamp.Country} issued in ${year}.`,
        specialNotes: stamp.seriesName || stamp.SeriesName ? `Part of the ${stamp.seriesName || stamp.SeriesName} series.` : ''
    }
}

// Generate carousel format for multiple stamps
function generateStampCarousel(stamps: any[]) {
    return {
        type: 'carousel',
        title: `Found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''}`,
        items: stamps.map(stamp => {
            const year = stamp.issueYear || stamp.IssueYear || (stamp.issueDate ? stamp.issueDate.split('-')[0] : stamp.IssueDate ? stamp.IssueDate.split('-')[0] : 'Unknown')
            // Use denominationSymbol if available, otherwise construct from denominationValue
            const denomination = stamp.denominationSymbol || stamp.DenominationSymbol || `${stamp.denominationValue || stamp.DenominationValue}`
            const subtitle = `${stamp.country || stamp.Country} • ${year} • ${denomination}`

            // Handle different possible image URL field names
            const imageUrl = stamp.stampImageUrl || stamp.StampImageUrl || stamp.image || stamp.StampImage || '/images/stamps/no-image-available.png'

            return {
                id: stamp.id || stamp.Id, // Use lowercase 'id' first, then fallback to 'Id'
                title: stamp.name || stamp.Name || stamp.catalogNumber || stamp.StampCatalogCode || 'Stamp',
                subtitle: subtitle,
                image: imageUrl,
                // Include the same detailed content as single cards
                content: [
                    {
                        section: 'Overview',
                        text: `${stamp.name || stamp.Name} from ${stamp.country || stamp.Country}, issued in ${year}. Denomination: ${denomination}. Color: ${stamp.color || stamp.Color || 'Unknown'}.`
                    },
                    {
                        section: 'Details',
                        details: [
                            { label: 'Catalog Code', value: stamp.catalogNumber || stamp.StampCatalogCode || 'N/A' },
                            { label: 'Issue Date', value: stamp.issueDate || stamp.IssueDate || 'N/A' },
                            { label: 'Color', value: stamp.color || stamp.Color || 'N/A' },
                            { label: 'Paper Type', value: stamp.paperType || stamp.PaperType || 'N/A' }
                        ]
                    }
                ],
                significance: `A ${stamp.color || stamp.Color || 'colorful'} stamp from ${stamp.country || stamp.Country} issued in ${year}.`,
                specialNotes: stamp.seriesName || stamp.SeriesName ? `Part of the ${stamp.seriesName || stamp.SeriesName} series.` : '',
                // Keep existing fields for backward compatibility
                summary: `${denomination} ${stamp.color || stamp.Color || 'Unknown'}`,
                marketValue: 'Value varies by condition',
                quickFacts: [
                    `${stamp.country || stamp.Country} ${year}`,
                    stamp.color || stamp.Color || 'Unknown',
                    denomination
                ]
            }
        })
    }
}

// Simple text cleaning - only remove technical references, preserve AI formatting
function cleanResponseText(text: string): string {
    // Only remove technical references and URLs, preserve AI's markdown formatting
    return text
        .replace(/download\.json/g, 'stamp database')
        .replace(/vector store/g, 'stamp collection')
        .replace(/file_search/g, 'search')
        .replace(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^\s\)\]]+/g, '')
        .replace(/ref as [^\s]+/g, '')
        .replace(/catalog number [A-Z0-9]+/gi, '')
        .replace(/Campbell Paterson Catalogue/g, 'stamp catalog')
        .replace(/catalog number/g, 'catalog')
        .trim()
}

// Health check endpoint
export async function GET() {
    return NextResponse.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        assistantId: ASSISTANT_ID,
        timeout: TIMEOUT_MS
    })
}

export async function POST(request: NextRequest) {
    try {
        const { message, stream = false, voiceChat = false, sessionId, history = [], conversationHistory = [] } = await request.json()
        // Use conversationHistory if available, otherwise fall back to history for backward compatibility
        const finalHistory = conversationHistory.length > 0 ? conversationHistory : history
        console.log('📨 API Request:', { message: message.substring(0, 50) + '...', stream, voiceChat, sessionId, historyLength: finalHistory.length })

        if (!message) {
            return NextResponse.json({ error: 'Message is required' }, { status: 400 })
        }

        // Check if streaming is requested
        if (stream) {
            console.log('🔄 Using streaming mode - bypassing main timeout mechanism')
            return handleStreamingResponse(message, voiceChat, sessionId, finalHistory)
        }

        // Fallback for non-streaming requests
        console.log('Using non-streaming mode for:', message)

        // For voice chat, use direct chat completion even in non-streaming mode
        if (voiceChat) {
            console.log('🎤 Using direct chat completion for voice chat (non-streaming) with history length:', finalHistory.length)

            try {
                // Build conversation context with history for non-streaming voice chat
                const messages = [
                    {
                        role: "system" as const,
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
                    ...finalHistory, // Include conversation history for context
                    {
                        role: "user" as const,
                        content: message
                    }
                ]

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages,
                    max_tokens: 1500,
                    temperature: 0.7
                })

                const response = completion.choices[0]?.message?.content || "I couldn't generate a response for that query."
                return NextResponse.json({ response })

            } catch (error) {
                console.error('❌ Voice chat error:', error)
                return NextResponse.json({ error: 'Failed to process voice chat request' }, { status: 500 })
            }
        }

        // Use OpenAI Assistant with file-based knowledge for non-voice chat
        console.log('Using OpenAI Assistant for:', message)

        // Call the assistant API with timeout
        let assistantResult
        try {
            // Create a timeout promise
            const timeoutPromise = createTimeoutPromise(TIMEOUT_MS)

            // Create the assistant call promise
            const assistantPromise = (async () => {
                // Step 1: First fetch the assistant (like in Flutter)
                const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID)
                console.log('✅ Assistant fetched:', assistant.id)

                // Step 2: Get or create thread based on session
                let threadId: string
                if (sessionId && activeThreads.has(sessionId)) {
                    // Use existing thread for conversation continuity
                    threadId = activeThreads.get(sessionId)!
                    console.log('🔄 Using existing thread:', threadId)

                    // OpenAI threads handle conversation history automatically
                    // await waitForThreadCompletion(threadId)
                } else {
                    // Create new thread for new conversation
                    const thread = await openai.beta.threads.create()
                    threadId = thread.id
                    if (sessionId) {
                        activeThreads.set(sessionId, threadId)
                    }
                    console.log('✅ New thread created:', threadId)
                }

                // Step 3: Add the user's message to the thread (OpenAI manages history automatically)
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

                const threadMessage = await openai.beta.threads.messages.create(threadId, {
                    role: 'user',
                    content: enhancedMessage
                })
                console.log('✅ Message created:', threadMessage.id)

                // Step 5: Create run with the assistant
                const run = await openai.beta.threads.runs.create(threadId, {
                    assistant_id: assistant.id
                })
                console.log('✅ Run created:', run.id)

                if (!run.id) {
                    throw new Error('Failed to create run - no run ID returned')
                }

                // Wait for run to complete with proper status checking
                console.log('⏳ Waiting for run to complete...')
                let runStatus = run.status
                let attempts = 0
                const maxAttempts = 6 // Reduced to 6 seconds max wait (6 attempts × 1 second) - less than TIMEOUT_MS

                while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < maxAttempts) {
                    console.log(`⏳ Run status: ${runStatus} (attempt ${attempts + 1}/${maxAttempts})`)
                    await new Promise(resolve => setTimeout(resolve, 1000)) // Reduced to 1 second

                    try {
                        const runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId })
                        runStatus = runResult.status
                        attempts++

                        // Log any errors
                        if (runResult.last_error) {
                            console.error('❌ Run error:', runResult.last_error)
                        }
                    } catch (error) {
                        console.error('❌ Error checking run status:', error)
                        break
                    }
                }

                console.log(`✅ Run completed with status: ${runStatus}`)

                // Check if run failed
                if (runStatus === 'failed') {
                    console.error('❌ Run failed')
                    throw new Error('Assistant run failed')
                }

                if (runStatus === 'cancelled') {
                    console.error('❌ Run cancelled')
                    throw new Error('Assistant run cancelled')
                }

                if (runStatus === 'expired') {
                    console.error('❌ Run expired')
                    throw new Error('Assistant run expired')
                }

                // If still in progress after timeout, return a quick response
                if (runStatus === 'queued' || runStatus === 'in_progress') {
                    console.log('⏰ Run still in progress after timeout, returning quick response')
                    return {
                        response: "I'm processing your request about stamps. This might take a moment. Please try again with a more specific query or check back in a few seconds.",
                        stampsFound: 0,
                        hasStructuredData: false,
                        stamps: [],
                        structuredData: null
                    }
                }

                // Handle requires_action (function calls)
                if (runStatus === 'requires_action') {
                    console.log('🔧 Run requires action - handling function calls...')

                    const runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId })
                    console.log('📊 Run result:', runResult)

                    if (runResult.required_action && runResult.required_action.type === 'submit_tool_outputs') {
                        console.log('🔧 Found tool outputs to submit')

                        const toolCalls = runResult.required_action.submit_tool_outputs.tool_calls
                        console.log('🔧 Tool calls found:', toolCalls.length)

                        const toolOutputs = []
                        let stamps = []
                        let structuredData = null

                        for (const toolCall of toolCalls) {
                            console.log('🔧 Processing tool call:', toolCall)
                            if (toolCall.function.name === 'return_stamp_data') {
                                try {
                                    const functionArgs = JSON.parse(toolCall.function.arguments)
                                    console.log('📊 Function call data:', functionArgs)

                                    if (functionArgs.stamps && Array.isArray(functionArgs.stamps)) {
                                        // VALIDATE: Check if stamps have real data, not just IDs
                                        const validStamps = functionArgs.stamps.filter((s: any) => {
                                            // Must have at least name, country, and year - not just ID
                                            const hasValidData = s.Name || s.name || s.Country || s.country || s.IssueYear || s.issueYear || s.issue_year
                                            if (!hasValidData) {
                                                console.log('🚨 INVALID STAMP DATA DETECTED (non-streaming) - Only ID provided:', s)
                                                return false
                                            }
                                            return true
                                        })

                                        if (validStamps.length === 0) {
                                            console.log('🚨 ALL STAMP DATA INVALID (non-streaming) - Providing fallback response')
                                            // Return helpful fallback response
                                            return {
                                                response: "I don't have specific catalog data for that query. Would you like me to help you with a different stamp question or provide general philatelic guidance?",
                                                stampsFound: 0,
                                                hasStructuredData: false,
                                                stamps: [],
                                                structuredData: null
                                            }
                                        }

                                        stamps = validStamps
                                        structuredData = functionArgs
                                        console.log(`✅ Found ${stamps.length} VALID stamps from function call (non-streaming)`)
                                    }
                                } catch (error) {
                                    console.log('❌ Error parsing function arguments:', error)
                                }
                            }

                            toolOutputs.push({
                                tool_call_id: toolCall.id,
                                output: JSON.stringify({ success: true, stamps: stamps })
                            })
                        }

                        // Create structured data immediately from function call
                        let immediateStructuredData = null
                        if (stamps.length === 1) {
                            console.log('🎴 Creating single stamp card with data:', stamps[0])
                            immediateStructuredData = generateStampCard(stamps[0])
                            console.log('🎴 Generated card data:', immediateStructuredData)
                        } else if (stamps.length > 1) {
                            console.log(`🎠 Creating carousel with ${stamps.length} stamps`)
                            immediateStructuredData = generateStampCarousel(stamps.slice(0, 5))
                            console.log('🎠 Generated carousel data:', immediateStructuredData)
                        }

                        // CRITICAL: Submit tool outputs back to the thread to complete the conversation
                        if (toolOutputs.length > 0) {
                            try {
                                console.log('📤 Submitting tool outputs back to thread (non-streaming):', toolOutputs.length, 'outputs')
                                await openai.beta.threads.runs.submitToolOutputs(run.id, {
                                    thread_id: threadId,
                                    tool_outputs: toolOutputs
                                })
                                console.log('✅ Tool outputs submitted successfully (non-streaming)')

                                // Wait for the run to complete after submitting tool outputs
                                console.log('⏳ Waiting for run to complete after tool output submission (non-streaming)...')
                                let finalRunStatus = 'in_progress'
                                let finalAttempts = 0
                                const maxFinalAttempts = 10 // Wait up to 10 seconds for completion

                                while (finalRunStatus === 'in_progress' && finalAttempts < maxFinalAttempts) {
                                    await new Promise(resolve => setTimeout(resolve, 1000))
                                    try {
                                        const finalRunResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId })
                                        finalRunStatus = finalRunResult.status
                                        finalAttempts++
                                        console.log(`⏳ Final run status (non-streaming): ${finalRunStatus} (attempt ${finalAttempts}/${maxFinalAttempts})`)

                                        if (finalRunStatus === 'completed') {
                                            console.log('✅ Run completed successfully after tool output submission (non-streaming)')
                                            break
                                        } else if (finalRunStatus === 'failed' || finalRunStatus === 'cancelled') {
                                            console.log(`❌ Run ${finalRunStatus} after tool output submission (non-streaming)`)
                                            break
                                        }
                                    } catch (error) {
                                        console.error('❌ Error checking final run status (non-streaming):', error)
                                        break
                                    }
                                }

                            } catch (submitError) {
                                console.error('❌ Error submitting tool outputs (non-streaming):', submitError)
                                // Don't fail the request, but log the error
                            }
                        }

                        // Return with function call data
                        return {
                            response: `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`,
                            stampsFound: stamps.length,
                            hasStructuredData: stamps.length > 0,
                            stamps: stamps,
                            structuredData: immediateStructuredData
                        }
                    }
                }

                // Get the messages from the thread
                const messages = await openai.beta.threads.messages.list(threadId)
                console.log('📨 Messages in thread:', messages.data.length)

                // Get the latest assistant message
                const assistantMessages = messages.data.filter(msg => msg.role === 'assistant')
                console.log('🤖 Assistant messages found:', assistantMessages.length)

                if (assistantMessages.length > 0) {
                    const latestAssistantMessage = assistantMessages[0] // Most recent is first
                    console.log('📝 Latest assistant message content length:', latestAssistantMessage.content.length)

                    if (latestAssistantMessage.content.length > 0) {
                        const content = latestAssistantMessage.content[0]
                        console.log('📄 Content type:', content.type)

                        if (content.type === 'text') {
                            const rawResponse = content.text.value
                            console.log('🤖 Assistant response:', rawResponse)
                            console.log('Response length:', rawResponse.length)
                            console.log('Contains JSON:', rawResponse.includes('{'))
                            console.log('Contains real image URLs:', rawResponse.includes('3pmplatformstorage.blob.core.windows.net'))

                            // Clean the response to remove technical references
                            const response = cleanResponseText(rawResponse)
                            console.log('🧹 Cleaned response:', response)

                            // Check for function calls in the message
                            let stamps = []
                            let structuredData = null
                            let hasFunctionCalls = false

                            // Look for function calls in the message
                            for (const contentItem of latestAssistantMessage.content as any[]) {
                                if (contentItem.type === 'tool_calls') {
                                    console.log('🔧 Found function calls in assistant message')
                                    console.log('🔧 Tool calls content:', contentItem)
                                    hasFunctionCalls = true

                                    for (const toolCall of contentItem.tool_calls) {
                                        console.log('🔧 Tool call:', toolCall)
                                        if (toolCall.function.name === 'return_stamp_data') {
                                            try {
                                                const functionArgs = JSON.parse(toolCall.function.arguments)
                                                console.log('📊 Function call data:', functionArgs)

                                                if (functionArgs.stamps && Array.isArray(functionArgs.stamps)) {
                                                    // VALIDATE: Check if stamps have real data, not just IDs
                                                    const validStamps = functionArgs.stamps.filter((s: any) => {
                                                        // Must have at least name, country, and year - not just ID
                                                        const hasValidData = s.Name || s.name || s.Country || s.country || s.IssueYear || s.issueYear || s.issue_year
                                                        if (!hasValidData) {
                                                            console.log('🚨 INVALID STAMP DATA DETECTED (message content) - Only ID provided:', s)
                                                            return false
                                                        }
                                                        return true
                                                    })

                                                    if (validStamps.length === 0) {
                                                        console.log('🚨 ALL STAMP DATA INVALID (message content) - Providing fallback response')
                                                        // Return helpful fallback response
                                                        return {
                                                            response: "I don't have specific catalog data for that query. Would you like me to help you with a different stamp question or provide general philatelic guidance?",
                                                            stampsFound: 0,
                                                            hasStructuredData: false,
                                                            stamps: [],
                                                            structuredData: null
                                                        }
                                                    }

                                                    stamps = validStamps
                                                    structuredData = functionArgs
                                                    console.log(`✅ Found ${stamps.length} VALID stamps from function call (message content)`)
                                                }
                                            } catch (error) {
                                                console.log('❌ Error parsing function arguments:', error)
                                            }
                                        }
                                    }
                                }
                            }

                            // If we have function calls, submit the results and get final response
                            if (hasFunctionCalls) {
                                console.log('🔄 Function call detected - displaying data immediately')

                                // Create structured data immediately from function call
                                let immediateStructuredData = null
                                if (stamps.length === 1) {
                                    immediateStructuredData = generateStampCard(stamps[0])
                                } else if (stamps.length > 1) {
                                    immediateStructuredData = generateStampCarousel(stamps.slice(0, 5))
                                }

                                // Return immediately with function call data
                                return {
                                    response: `I found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''} for you.`,
                                    stampsFound: stamps.length,
                                    hasStructuredData: stamps.length > 0,
                                    stamps: stamps,
                                    structuredData: immediateStructuredData
                                }

                                // Optionally, you can still submit tool outputs and get conversational response
                                // But for now, let's just return the immediate data
                            } else {
                                // No function calls - this is a generic response, no structured data needed
                                console.log('🔍 No function calls found - this is a generic response')

                                return {
                                    response: response,
                                    stampsFound: 0,
                                    hasStructuredData: false,
                                    stamps: [],
                                    structuredData: null
                                }
                            }
                        } else {
                            console.log('❌ Content is not text type:', content.type)
                        }
                    } else {
                        console.log('❌ Assistant message has no content')
                    }
                } else {
                    console.log('❌ No assistant messages found in thread')
                }

                return {
                    response: 'I apologize, but I encountered an error while processing your request. Please try again in a moment.',
                    stamps: []
                }
            })()

            // Race between the assistant call and timeout
            assistantResult = await Promise.race([assistantPromise, timeoutPromise])

        } catch (error) {
            console.error('Assistant API error:', error)
            console.error('Error details:', {
                message: error instanceof Error ? error.message : 'Unknown error',
                status: (error as any)?.status,
                type: (error as any)?.type
            })

            // Check if it's a timeout error
            if (error instanceof Error && error.message === 'Request timeout') {
                return NextResponse.json({
                    error: 'The assistant is taking too long to respond. Please try again with a more specific query about stamps, or try asking about a particular country or year.'
                }, { status: 408 })
            }

            assistantResult = {
                response: 'I apologize, but I encountered an error while processing your request. Please try again in a moment.',
                stamps: []
            }
        }

        let foundStamps: any[] = []
        let aiResponse = assistantResult.response

        console.log('Assistant result:', {
            response: assistantResult.response,
            stampsFound: assistantResult.stamps?.length || 0,
            hasStructuredData: !!assistantResult.structuredData
        })

        // Use assistant results - even if no structured data, use the response
        if (assistantResult.stamps && assistantResult.stamps.length > 0) {
            console.log(`Assistant found ${assistantResult.stamps.length} stamps`)
            foundStamps = assistantResult.stamps

            // Use the full assistant response for conversational display
            aiResponse = assistantResult.response
        } else {
            console.log('No structured data found, but using assistant response')
            aiResponse = assistantResult.response || "I couldn't find specific stamps matching your query in my database. Try searching for different terms or ask about general philatelic topics."
        }

        // Generate structured data for UI display ONLY if we have stamps from function calls
        let structuredData = null
        if (foundStamps.length === 1) {
            console.log('🎴 Generating single stamp card with data:', foundStamps[0])
            structuredData = generateStampCard(foundStamps[0])
            console.log('🎴 Generated card data:', structuredData)
        } else if (foundStamps.length > 1) {
            console.log(`🎠 Generating carousel with ${foundStamps.length} stamps`)
            structuredData = generateStampCarousel(foundStamps.slice(0, 5)) // Limit to 5 stamps in carousel
            console.log('🎠 Generated carousel data:', structuredData)
        } else {
            console.log('📝 No stamps found - no structured data generated')
        }

        console.log('📤 Final response data:', {
            response: aiResponse,
            structuredData: structuredData,
            foundStamps: foundStamps.length
        })

        return NextResponse.json({
            response: aiResponse,
            structuredData,
            foundStamps: foundStamps.length,
            metadata: {
                source: foundStamps.length > 0 ? 'openai_assistant' : 'internet_search'
            }
        })

    } catch (error) {
        console.error('PhilaGuide API error:', error)
        return NextResponse.json({
            error: 'Request timed out. Please try again.'
        }, { status: 408 })
    }
}

// Parse response for stamp data
function parseResponse(response: string): { stamps: any[], structuredData?: any } {
    try {
        console.log('Parsing response:', response.substring(0, 200) + '...')

        // Try to extract JSON from the response - look for JSON blocks
        const jsonMatch = response.match(/```json\s*(\{[\s\S]*?\})\s*```/)
        if (jsonMatch) {
            console.log('Found JSON block in response')
            const jsonData = JSON.parse(jsonMatch[1])

            if (jsonData.stamps && Array.isArray(jsonData.stamps)) {
                console.log('Successfully parsed stamps from JSON block')
                return {
                    stamps: jsonData.stamps,
                    structuredData: jsonData
                }
            }
        }

        // Try to extract JSON without code blocks
        const jsonMatch2 = response.match(/\{[\s\S]*\}/)
        if (jsonMatch2) {
            console.log('Found JSON in response (no code blocks)')
            const jsonData = JSON.parse(jsonMatch2[0])

            if (jsonData.stamps && Array.isArray(jsonData.stamps)) {
                console.log('Successfully parsed stamps from JSON')
                return {
                    stamps: jsonData.stamps,
                    structuredData: jsonData
                }
            }
        }

        // Check if response contains real image URLs but no JSON structure
        if (response.includes('3pmplatformstorage.blob.core.windows.net')) {
            console.log('Response contains real image URLs but no JSON structure')
            // Try to extract stamp information from text
            const stampInfo = extractStampInfoFromText(response)
            if (stampInfo) {
                return {
                    stamps: [stampInfo],
                    structuredData: { stamps: [stampInfo] }
                }
            }
        }

        // New: Try to extract stamp data from conversational responses
        const extractedStamps = extractStampsFromConversation(response)
        if (extractedStamps.length > 0) {
            console.log('Successfully extracted stamps from conversational response')
            return {
                stamps: extractedStamps,
                structuredData: { stamps: extractedStamps }
            }
        }

        console.log('No valid JSON or stamp data found in response')
        return { stamps: [] }
    } catch (error) {
        console.log('❌ Failed to parse response:', error)
        return { stamps: [] }
    }
}

// Detect if response contains internet-based information and extract sources
function detectInternetBasedContent(text: string): { isInternetBased: boolean; sources: string[] } {
    // Look for actual URLs and source names
    const urlPattern = /https?:\/\/[^\s\)\]]+/g
    const sourcePatterns = [
        /according to\s+\[([^\]]+)\]\(([^)]+)\)/gi,
        /as reported by\s+\[([^\]]+)\]\(([^)]+)\)/gi,
        /based on\s+\[([^\]]+)\]\(([^)]+)\)/gi,
        /source:\s*([^\n]+)/gi,
        /from\s+([^\n]+)/gi
    ]

    const urls = text.match(urlPattern) || []
    const sources: string[] = []

    // Extract source names from markdown links
    for (const pattern of sourcePatterns) {
        const matches = text.matchAll(pattern)
        for (const match of matches) {
            if (match[1] && match[2]) {
                sources.push(`${match[1]} (${match[2]})`)
            }
        }
    }

    // Add plain URLs as sources
    urls.forEach(url => {
        try {
            const domain = new URL(url).hostname
            sources.push(`${domain} (${url})`)
        } catch {
            sources.push(url)
        }
    })

    const isInternetBased = urls.length > 0 || sources.length > 0

    return { isInternetBased, sources }
}

// Extract stamp information from conversational text
function extractStampsFromConversation(text: string): any[] {
    const stamps = []

    // Look for patterns like "Trout Blue 1/3d" stamp from New Zealand
    const stampPatterns = [
        /"([^"]+)"\s+stamp\s+from\s+([^,]+)/gi,
        /([^"]+)\s+stamp\s+from\s+([^,]+)/gi,
        /([^"]+)\s+from\s+([^,]+)/gi
    ]

    for (const pattern of stampPatterns) {
        const matches = text.matchAll(pattern)
        for (const match of matches) {
            const stampName = match[1]?.trim()
            const country = match[2]?.trim()

            if (stampName && country) {
                // Look for additional details in the text
                const yearMatch = text.match(/(\d{4})/)
                const year = yearMatch ? yearMatch[1] : 'Unknown'

                const denominationMatch = text.match(/(\d+[\/\d]*\s*[a-z]+)/i)
                const denomination = denominationMatch ? denominationMatch[1] : 'Unknown'

                const colorMatch = text.match(/(blue|red|green|yellow|brown|grey|gray|black|white|orange|purple|pink)/i)
                const color = colorMatch ? colorMatch[1] : 'Unknown'

                // Look for image URL
                const imageUrlMatch = text.match(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^\s\)\]]+/)
                const imageUrl = imageUrlMatch ? imageUrlMatch[0] : '/images/stamps/no-image-available.png'

                stamps.push({
                    Id: `extracted-${Date.now()}-${stamps.length}`,
                    Name: stampName,
                    Country: country,
                    IssueYear: year,
                    DenominationValue: denomination.includes('/') ? 1 : parseFloat(denomination.match(/\d+/)?.[0] || '1'),
                    DenominationSymbol: denomination.includes('d') ? 'd' : denomination.includes('c') ? 'c' : '',
                    StampImageUrl: imageUrl,
                    Color: color,
                    SeriesName: 'Extracted from response',
                    IssueDate: year !== 'Unknown' ? `${year}-01-01` : null,
                    PaperType: 'Unknown',
                    CatalogNumber: 'N/A'
                })
            }
        }
    }

    return stamps
}

// Extract stamp information from text when JSON parsing fails
function extractStampInfoFromText(text: string): any | null {
    try {
        // Look for image URLs in the text
        const imageUrlMatch = text.match(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^\s\)\]]+/)
        if (imageUrlMatch) {
            const imageUrl = imageUrlMatch[0]

            // Try to extract basic stamp info from the text
            const nameMatch = text.match(/\*\*([^*]+)\*\*/)
            const countryMatch = text.match(/Country[:\s]+([^\n]+)/i)
            const yearMatch = text.match(/Year[:\s]+([^\n]+)/i) || text.match(/(\d{4})/)
            const denominationMatch = text.match(/Denomination[:\s]+([^\n]+)/i)

            return {
                id: `extracted-${Date.now()}`,
                name: nameMatch ? nameMatch[1].trim() : 'Stamp',
                country: countryMatch ? countryMatch[1].trim() : 'Unknown',
                year: yearMatch ? yearMatch[1].trim() : 'Unknown',
                denomination: denominationMatch ? denominationMatch[1].trim() : 'Unknown',
                image: imageUrl,
                description: text.substring(0, 200) + '...',
                marketValue: 'Unknown',
                rarity: 'Unknown'
            }
        }

        return null
    } catch (error) {
        console.log('Failed to extract stamp info from text:', error)
        return null
    }
} 