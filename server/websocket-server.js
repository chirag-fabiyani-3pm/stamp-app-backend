// Load environment variables
require('dotenv').config({ path: '.env.local' })

const WebSocket = require('ws')
const OpenAI = require('openai')
// const { createServer } = require('http') // no longer used; we attach to existing server
// const FormData = require('form-data') // not used
// fetch is available globally in Node.js 18+

class OpenAIWebSocketServer {
    constructor(httpServer) {

        // Check if OpenAI API key is available
        if (!process.env.OPENAI_API_KEY) {
            console.warn('⚠️  Warning: OPENAI_API_KEY environment variable is not set')
            console.warn('⚠️  WebSocket server will start but OpenAI integration will not work')
            console.warn('⚠️  Please set OPENAI_API_KEY in your .env.local file')
            console.warn('⚠️  Current .env.local path:', require('path').resolve('.env.local'))
            console.warn('⚠️  Available env vars:', Object.keys(process.env).filter(key => key.includes('OPENAI')))
        } else {
            console.log('✅ OpenAI API key found:', process.env.OPENAI_API_KEY.substring(0, 10) + '...')
        }

        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY || 'dummy-key'
        })

        // Store active connections and OpenAI sessions
        this.activeConnections = new Map() // clientId -> { ws, openaiWs, sessionId, openaiSessionId, clientSecret, sessionReady, audioQueue }
        this.openaiSessions = new Map() // sessionId -> { openaiSessionId, clientSecret, voice, instructions }

        this.setupServer(httpServer)
        console.log('🎤 WebSocket Server: Attached to existing HTTP server on path /webrtc')
    }

    setupServer(httpServer) {
        // Use provided HTTP server for WebSocket upgrade
        this.httpServer = httpServer

        // Create WebSocket server
        this.wss = new WebSocket.Server({
            server: this.httpServer,
            path: '/webrtc'
        })

        // Handle WebSocket connections
        this.wss.on('connection', this.handleConnection.bind(this))

    }

    async handleConnection(ws, req) {
        const clientId = this.generateClientId()
        console.log(`🎤 WebSocket Server: New client connected: ${clientId}`)

        // Store connection info
        this.activeConnections.set(clientId, {
            ws,
            openaiWs: null,
            sessionId: null,
            openaiSessionId: null,
            clientSecret: null,
            sessionReady: false, // New: Track if session is ready
            audioQueue: [] // New: Queue for audio data
        })

        // Handle client messages
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString())
                await this.handleClientMessage(clientId, message)
            } catch (error) {
                console.error(`🎤 WebSocket Server: Error handling message from ${clientId}:`, error)
                this.sendError(ws, 'Invalid message format')
            }
        })

        // Handle client disconnect
        ws.on('close', () => {
            console.log(`🎤 WebSocket Server: Client disconnected: ${clientId}`)
            this.cleanupConnection(clientId)
        })

        // Handle client errors
        ws.on('error', (error) => {
            console.error(`🎤 WebSocket Server: Client error for ${clientId}:`, error)
            this.cleanupConnection(clientId)
        })

        // Send connection confirmation
        ws.send(JSON.stringify({
            type: 'connection.established',
            clientId,
            message: 'Connected to OpenAI WebSocket Server'
        }))
    }

    async handleClientMessage(clientId, message) {
        const connection = this.activeConnections.get(clientId)
        if (!connection) {
            console.error(`🎤 WebSocket Server: Connection not found for client ${clientId}`)
            return
        }

        const { ws, openaiWs } = connection

        try {
            switch (message.type) {
                case 'session.create':
                    await this.handleSessionCreate(clientId, message)
                    break

                case 'input_audio_buffer.append':
                    await this.handleAudioInput(clientId, message)
                    break

                default:
                    console.log(`🎤 WebSocket Server: Unknown message type: ${message.type}`)
                    this.sendError(ws, `Unknown message type: ${message.type}`)
            }
        } catch (error) {
            console.error(`🎤 WebSocket Server: Error handling message:`, error)
            this.sendError(ws, 'Internal server error')
        }
    }

    async handleSessionCreate(clientId, message) {
        const connection = this.activeConnections.get(clientId)
        const { ws } = connection

        try {
            // Check if OpenAI API key is available
            if (!process.env.OPENAI_API_KEY) {
                throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY in your environment variables.')
            }

            console.log(`🎤 WebSocket Server: Creating OpenAI session for client ${clientId}`)

            // Test OpenAI API access
            try {
                const testResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'gpt-4',
                        messages: [{ role: 'user', content: 'Hello' }],
                        max_tokens: 10
                    })
                })

                if (!testResponse.ok) {
                    const errorData = await testResponse.json().catch(() => ({}))
                    console.error(`🎤 WebSocket Server: OpenAI API test failed:`, testResponse.status, errorData)
                    throw new Error(`OpenAI API error: ${testResponse.status} - ${errorData.error?.message || 'Unknown error'}`)
                }

                console.log(`🎤 WebSocket Server: OpenAI API access confirmed`)

            } catch (testError) {
                console.error(`🎤 WebSocket Server: OpenAI API test error:`, testError)
                throw testError
            }

            // Try to create a realtime session first
            try {
                console.log(`🎤 WebSocket Server: Attempting to create Realtime API session...`)

                const realtimeResponse = await fetch('http://localhost:3000/api/realtime-stream', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        voice: message.voice || 'alloy',
                        instructions: message.instructions || 'You are a knowledgeable stamp collecting expert. Answer questions about stamps, their history, and collecting. Keep responses concise and helpful. Respond naturally to user voice input.'
                    })
                })

                if (realtimeResponse.ok) {
                    const realtimeData = await realtimeResponse.json()
                    console.log(`🎤 WebSocket Server: Realtime API session created: ${realtimeData.sessionId}`)

                    // Store session info
                    connection.sessionId = realtimeData.sessionId
                    connection.openaiSessionId = realtimeData.sessionId
                    // Extract the actual secret value from the client_secret object
                    connection.clientSecret = realtimeData.client_secret?.value || realtimeData.client_secret
                    connection.sessionReady = true // Mark session as ready

                    console.log(`🎤 WebSocket Server: Extracted client secret: ${connection.clientSecret}`)

                    this.openaiSessions.set(realtimeData.sessionId, {
                        openaiSessionId: realtimeData.sessionId,
                        clientSecret: realtimeData.client_secret?.value || realtimeData.client_secret,
                        voice: message.voice || 'alloy',
                        instructions: message.instructions || 'You are a knowledgeable stamp collecting expert. Answer questions about stamps, their history, and collecting. Keep responses concise and helpful. Respond naturally to user voice input.'
                    })

                    // Process any queued audio
                    this.processQueuedAudio(realtimeData.sessionId)

                    // Send success response
                    ws.send(JSON.stringify({
                        type: 'session.created',
                        sessionId: realtimeData.sessionId,
                        message: 'OpenAI Realtime API session created successfully'
                    }))

                    return
                } else {
                    console.log(`🎤 WebSocket Server: Realtime API failed, falling back to virtual session`)
                }
            } catch (realtimeError) {
                console.log(`🎤 WebSocket Server: Realtime API error, falling back to virtual session:`, realtimeError.message)
            }

            // Fallback: Create a virtual session for this client
            const sessionId = `session_${clientId}_${Date.now()}`
            console.log(`🎤 WebSocket Server: Virtual session created: ${sessionId}`)

            // Store session info
            connection.sessionId = sessionId
            connection.openaiSessionId = sessionId
            connection.sessionReady = true // Mark session as ready

            this.openaiSessions.set(sessionId, {
                openaiSessionId: sessionId,
                voice: message.voice || 'alloy',
                instructions: message.instructions || 'You are a helpful AI assistant.'
            })

            // Process any queued audio
            this.processQueuedAudio(sessionId)

            // Send success response
            ws.send(JSON.stringify({
                type: 'session.created',
                sessionId: sessionId,
                message: 'OpenAI session created using regular API (fallback)'
            }))

        } catch (error) {
            console.error(`🎤 WebSocket Server: Failed to create OpenAI session:`, error)
            this.sendError(ws, `Failed to create OpenAI session: ${error.message}`)
        }
    }

    async handleAudioInput(clientId, message) {
        const connection = this.activeConnections.get(clientId)
        if (!connection) {
            this.sendError(connection.ws, 'No active connection')
            return
        }

        try {
            console.log(`🎤 WebSocket Server: Processing audio for client ${clientId}`)

            // Check if session is ready
            if (!connection.sessionReady || !connection.sessionId) {
                console.log(`🎤 WebSocket Server: Session not ready, queuing audio for client ${clientId}`)
                connection.audioQueue.push(message)
                return
            }

            // Get session info
            const sessionInfo = this.openaiSessions.get(connection.sessionId)
            if (!sessionInfo) {
                console.log(`🎤 WebSocket Server: Session info not found, queuing audio for client ${clientId}`)
                connection.audioQueue.push(message)
                return
            }

            console.log(`🎤 WebSocket Server: Audio received, length: ${message.audio?.length || 0} chars`)

            // Step 1: Convert base64 audio to audio buffer
            const audioBuffer = Buffer.from(message.audio, 'base64')
            console.log(`🎤 WebSocket Server: Audio converted to buffer, size: ${audioBuffer.length} bytes`)

            // Step 2: Use Realtime API for fast speech-to-text and response
            console.log(`🎤 WebSocket Server: Using Realtime API for fast processing...`)

            // Check if we have a Realtime API session
            console.log(`🎤 WebSocket Server: Checking Realtime API session...`)
            console.log(`🎤 WebSocket Server: Session ID: ${connection.openaiSessionId}`)
            console.log(`🎤 WebSocket Server: Client Secret: ${connection.clientSecret ? 'Present' : 'Missing'}`)
            if (connection.clientSecret) {
                console.log(`🎤 WebSocket Server: Client Secret type: ${typeof connection.clientSecret}`)
                console.log(`🎤 WebSocket Server: Client Secret preview: ${String(connection.clientSecret).substring(0, 20)}...`)
            }

            // Always try Realtime API first since we can connect directly from Node.js server
            if (true) {
                let openaiWs = null

                try {
                    // Connect to OpenAI Realtime WebSocket from NODE.JS SERVER (no browser limitations!)
                    console.log(`🎤 WebSocket Server: Attempting to connect to Realtime API from server...`)

                    // Use the correct base Realtime API endpoint (no session needed!)
                    const endpoint = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`
                    console.log(`🎤 WebSocket Server: Connecting to Realtime API: ${endpoint}`)

                    // Create WebSocket connection from Node.js server using regular API key!
                    openaiWs = new WebSocket(endpoint, {
                        headers: {
                            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                            'OpenAI-Beta': 'realtime=v1',
                            'User-Agent': 'Node.js-WebSocket-Client'
                        }
                    })

                    // Wait for connection
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000)

                        openaiWs.on('open', () => {
                            clearTimeout(timeout)
                            console.log(`🎤 WebSocket Server: Successfully connected to Realtime API`)
                            resolve()
                        })

                        openaiWs.on('error', (error) => {
                            clearTimeout(timeout)
                            reject(error)
                        })
                    })

                    // Send the audio data to Realtime API
                    console.log(`🎤 WebSocket Server: Sending audio to Realtime API...`)

                    // Configure session first
                    openaiWs.send(JSON.stringify({
                        type: 'session.update',
                        session: {
                            modalities: ['text', 'audio'],
                            instructions: `You are a knowledgeable stamp collecting expert and navigation assistant.

                            CRITICAL: Always respond in the SAME LANGUAGE the user speaks. Detect the user's spoken language from their audio and match it exactly. If the language is unclear, ask a brief clarifying question in the most likely detected language.

                            You help with:
                            1. Stamp collecting (philatelly) questions, history, and values
                            2. App navigation and features  
                            3. General philatelic knowledge

                            Keep responses concise, helpful, and always in the user's language.
                            `,
                            voice: 'alloy',
                            input_audio_format: 'pcm16',
                            output_audio_format: 'pcm16',
                            input_audio_transcription: {
                                model: 'whisper-1'
                            },
                            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200 },
                            tools: [],
                            tool_choice: 'auto',
                            temperature: 0.8,
                            max_response_output_tokens: 4096
                        }
                    }))

                    console.log(`🎤 WebSocket Server: Appending audio buffer, size: ${audioBuffer.length} bytes`)
                    // Append the audio to the buffer
                    openaiWs.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: message.audio
                    }))
                    console.log(`🎤 WebSocket Server: ✅ Audio buffer appended`)

                    console.log(`🎤 WebSocket Server: Committing audio buffer for transcription...`)
                    // Commit the audio buffer
                    openaiWs.send(JSON.stringify({
                        type: 'input_audio_buffer.commit'
                    }))
                    console.log(`🎤 WebSocket Server: ✅ Audio buffer committed`)

                    // CRITICAL: Create a user conversation item that consumes the committed buffer
                    console.log(`🎤 WebSocket Server: Creating user conversation item from committed audio buffer...`)
                    openaiWs.send(JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'user',
                            content: [
                                { type: 'input_audio' } // Uses the most recently committed input_audio_buffer
                            ]
                        }
                    }))
                    console.log(`🎤 WebSocket Server: ✅ User conversation item created`)

                    console.log(`🎤 WebSocket Server: Creating response...`)
                    // Create a response
                    openaiWs.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                            modalities: ['text', 'audio'],
                            instructions: 'Please respond as a helpful stamp collecting expert.'
                        }
                    }))
                    console.log(`🎤 WebSocket Server: ✅ Response create request sent`)

                    openaiWs.on('message', (data) => {
                        try {
                            const response = JSON.parse(data.toString())
                            console.log(`🎤 WebSocket Server: Realtime API response:`, response)

                            // Log all transcription-related events for debugging
                            if (response.type.includes('transcription') || response.type.includes('input_audio')) {
                                console.log(`🎙️ TRANSCRIPTION EVENT:`, response.type, response)
                            }

                            // Handle different response types from Realtime API
                            if (response.type === 'response.text.delta') {
                                // Forward text response to client
                                connection.ws.send(JSON.stringify({
                                    type: 'response.text.delta',
                                    delta: response.delta || '',
                                    sessionId: connection.sessionId
                                }))
                            } else if (response.type === 'conversation.item.input_audio_transcription.delta') {
                                // Forward user transcription delta (if available)
                                connection.ws.send(JSON.stringify({
                                    type: 'transcription.delta',
                                    delta: response.delta || '',
                                    sessionId: connection.sessionId
                                }))
                            } else if (response.type === 'conversation.item.input_audio_transcription.completed') {
                                // User's speech was transcribed
                                console.log(`🎤 WebSocket Server: ✅ USER TRANSCRIPTION RECEIVED:`, response.transcript)
                                console.log(`🎤 WebSocket Server: Sending transcription to client...`)
                                connection.ws.send(JSON.stringify({
                                    type: 'transcription.complete',
                                    text: response.transcript || '',
                                    sessionId: connection.sessionId
                                }))
                                console.log(`🎤 WebSocket Server: ✅ TRANSCRIPTION SENT TO CLIENT`)
                            } else if (response.type === 'response.audio_transcript.delta') {
                                // Stream AI's speech transcription in real-time
                                console.log(`🎤 WebSocket Server: AI transcript delta:`, response.delta)
                                connection.ws.send(JSON.stringify({
                                    type: 'response.text.delta',
                                    delta: response.delta || '',
                                    sessionId: connection.sessionId
                                }))
                            } else if (response.type === 'response.audio_transcript.done') {
                                // AI's speech transcription is complete (no need to send again - was streamed via deltas)
                                console.log(`🎤 WebSocket Server: AI transcript complete:`, response.transcript)
                            } else if (response.type === 'response.done') {
                                // Response is complete - trigger completion
                                console.log(`🎤 WebSocket Server: Response complete`)
                                connection.ws.send(JSON.stringify({
                                    type: 'response.complete',
                                    sessionId: connection.sessionId
                                }))
                            } else if (response.type === 'response.audio.delta') {
                                // Forward audio data directly to client
                                console.log(`🎤 WebSocket Server: Forwarding audio delta`, {
                                    hasAudio: !!response.audio,
                                    hasDelta: !!response.delta,
                                    audioLength: response.audio ? response.audio.length : 0,
                                    deltaLength: response.delta ? response.delta.length : 0
                                })
                                connection.ws.send(JSON.stringify({
                                    type: 'response.audio.delta',
                                    audio: response.delta || '',  // Audio data is in delta field!
                                    sessionId: connection.sessionId
                                }))
                            } else if (response.type === 'response.audio.done') {
                                // Audio generation complete
                                console.log(`🎤 WebSocket Server: Audio generation complete`)
                                connection.ws.send(JSON.stringify({
                                    type: 'response.audio.done',
                                    sessionId: connection.sessionId
                                }))
                            } else if (response.type === 'conversation.ended') {
                                console.log(`🎤 WebSocket Server: Conversation ended`)
                            } else {
                                console.log(`🎤 WebSocket Server: Unknown response type:`, response.type)
                            }
                        } catch (error) {
                            console.error(`🎤 WebSocket Server: Error parsing Realtime API response:`, error)
                        }
                    })

                    openaiWs.on('error', (error) => {
                        console.error(`🎤 WebSocket Server: Realtime API WebSocket error:`, error)
                        // Fall back to regular API if Realtime fails
                        this.processAudioWithRegularAPI(connection, audioBuffer)
                    })

                    openaiWs.on('close', () => {
                        console.log(`🎤 WebSocket Server: Realtime API WebSocket closed`)
                    })

                } catch (error) {
                    console.error(`🎤 WebSocket Server: Failed to use Realtime API, falling back:`, error)
                    // Fall back to regular API
                    this.processAudioWithRegularAPI(connection, audioBuffer)
                }
            } else {
                console.log(`🎤 WebSocket Server: No Realtime API session, using regular API`)
                // Fall back to regular API
                this.processAudioWithRegularAPI(connection, audioBuffer)
            }

        } catch (error) {
            console.error(`🎤 WebSocket Server: Error processing audio:`, error)
            this.sendError(connection.ws, `Failed to process audio: ${error.message}`)
        }
    }

    // Optimized method for regular API processing (faster than Realtime API workaround)
    async processAudioWithRegularAPI(connection, audioBuffer) {
        try {
            console.log(`🎤 WebSocket Server: Processing audio with optimized regular API...`)

            // Use streaming for faster response
            const startTime = Date.now()

            // Create multipart form data manually  
            const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substr(2)
            const parts = []

            // Add file part header
            parts.push(Buffer.from(`--${boundary}\r\n`))
            parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n`))
            parts.push(Buffer.from(`Content-Type: audio/webm\r\n\r\n`))
            parts.push(audioBuffer)
            parts.push(Buffer.from('\r\n'))

            // Add model part
            parts.push(Buffer.from(`--${boundary}\r\n`))
            parts.push(Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`))
            parts.push(Buffer.from('whisper-1\r\n'))
            parts.push(Buffer.from(`--${boundary}--\r\n`))

            const body = Buffer.concat(parts)
            console.log(`🎤 WebSocket Server: Starting speech-to-text (${body.length} bytes)...`)

            // Parallel processing: Start transcription and prepare chat
            const [transcriptionResponse] = await Promise.all([
                fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                        'Content-Type': `multipart/form-data; boundary=${boundary}`
                    },
                    body: body
                })
            ])

            if (!transcriptionResponse.ok) {
                const errorText = await transcriptionResponse.text()
                console.log(`🎤 WebSocket Server: Whisper API error response: ${errorText}`)

                let errorMessage = `Whisper API error: ${transcriptionResponse.status}`
                try {
                    const errorData = JSON.parse(errorText)
                    errorMessage += ` - ${errorData.error?.message || 'Unknown error'}`
                } catch (parseError) {
                    errorMessage += ` - ${errorText}`
                }

                throw new Error(errorMessage)
            }

            const transcriptionData = await transcriptionResponse.json()
            const userQuestion = transcriptionData.text
            console.log(`🎤 WebSocket Server: User said: "${userQuestion}"`)

            const transcriptionTime = Date.now() - startTime
            console.log(`🎤 WebSocket Server: Speech-to-text completed (${transcriptionTime}ms)`)

            // Send transcribed text immediately for faster feedback
            connection.ws.send(JSON.stringify({
                type: 'transcription.complete',
                text: userQuestion,
                sessionId: connection.sessionId
            }))

            // Use streaming GPT-4o-mini for faster response
            console.log(`🎤 WebSocket Server: Sending question to GPT-4o-mini with streaming...`)
            const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini', // Much faster than gpt-4
                    messages: [
                        {
                            role: 'system',
                            content: `You are a knowledgeable stamp collecting expert. Answer questions about stamps, their history, and collecting. Keep responses concise, helpful, and engaging. Respond naturally as if having a conversation.`
                        },
                        {
                            role: 'user',
                            content: userQuestion
                        }
                    ],
                    max_tokens: 200,
                    temperature: 0.7,
                    stream: true // Enable streaming for real-time response
                })
            })

            if (!gptResponse.ok) {
                const errorData = await gptResponse.json().catch(() => ({}))
                throw new Error(`GPT-4 API error: ${gptResponse.status} - ${errorData.error?.message || 'Unknown error'}`)
            }

            // Process streaming response for real-time output
            const reader = gptResponse.body?.getReader()
            if (!reader) {
                throw new Error('No response stream available')
            }

            let fullResponse = ''
            const decoder = new TextDecoder()

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    const chunk = decoder.decode(value)
                    const lines = chunk.split('\n')

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6)
                            if (data === '[DONE]') continue

                            try {
                                const parsed = JSON.parse(data)
                                const delta = parsed.choices?.[0]?.delta?.content
                                if (delta) {
                                    fullResponse += delta
                                    // Send each chunk immediately for real-time streaming
                                    connection.ws.send(JSON.stringify({
                                        type: 'response.text.delta',
                                        delta: delta,
                                        sessionId: connection.sessionId
                                    }))
                                }
                            } catch (e) {
                                // Skip invalid JSON lines
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock()
            }

            const totalTime = Date.now() - startTime
            console.log(`🎤 WebSocket Server: Complete response: "${fullResponse}" (${totalTime}ms total)`)

            // Send completion signal
            connection.ws.send(JSON.stringify({
                type: 'response.complete',
                sessionId: connection.sessionId
            }))

        } catch (error) {
            console.error(`🎤 WebSocket Server: Error in regular API fallback:`, error)
            this.sendError(connection.ws, `Failed to process audio: ${error.message}`)
        }
    }

    async processQueuedAudio(sessionId) {
        // Find the connection that has this sessionId
        let targetConnection = null
        let targetClientId = null

        for (const [clientId, connection] of this.activeConnections) {
            if (connection.sessionId === sessionId) {
                targetConnection = connection
                targetClientId = clientId
                break
            }
        }

        if (!targetConnection || !targetConnection.audioQueue) {
            return
        }

        console.log(`🎤 WebSocket Server: Processing ${targetConnection.audioQueue.length} queued audio messages for session ${sessionId}`)

        // Process all queued audio messages
        const queue = [...targetConnection.audioQueue] // Copy the queue
        targetConnection.audioQueue = [] // Clear the queue

        for (const message of queue) {
            try {
                await this.handleAudioInput(targetClientId, message)
            } catch (error) {
                console.error(`🎤 WebSocket Server: Error processing queued audio for session ${sessionId}:`, error)
                this.sendError(targetConnection.ws, `Failed to process queued audio: ${error.message}`)
            }
        }
    }

    sendError(ws, message) {
        ws.send(JSON.stringify({
            type: 'error',
            error: message
        }))
    }

    cleanupConnection(clientId) {
        const connection = this.activeConnections.get(clientId)
        if (connection) {
            // Close OpenAI WebSocket if open
            if (connection.openaiWs) {
                connection.openaiWs.close()
            }

            // Remove from active connections
            this.activeConnections.delete(clientId)

            // Remove from OpenAI sessions if this was the last connection
            if (connection.sessionId) {
                this.openaiSessions.delete(connection.sessionId)
            }
        }
    }

    generateClientId() {
        return 'client_' + Math.random().toString(36).substr(2, 9)
    }

    // Graceful shutdown
    shutdown() {
        console.log('🎤 WebSocket Server: Shutting down...')

        // Close all client connections
        for (const [clientId, connection] of this.activeConnections) {
            if (connection.ws) {
                connection.ws.close()
            }
            if (connection.openaiWs) {
                connection.openaiWs.close()
            }
        }

        // Close WebSocket server
        if (this.wss) {
            this.wss.close()
        }

        // Do not close the shared HTTP server; owner controls its lifecycle
        console.log('🎤 WebSocket Server: Shutdown complete')
    }
}

// Export factory to attach to an existing HTTP server
function attachOpenAIWebSocketServer(httpServer) {
    return new OpenAIWebSocketServer(httpServer)
}

module.exports = { OpenAIWebSocketServer, attachOpenAIWebSocketServer }