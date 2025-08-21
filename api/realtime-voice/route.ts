import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: NextRequest) {
    try {
        const { voice = 'alloy', instructions } = await request.json()

        console.log('🎤 Realtime voice chat request:', {
            voice,
            instructions: instructions ? instructions.substring(0, 50) + '...' : 'Default instructions'
        })

        // Create a realtime voice session according to OpenAI documentation
        const session = await openai.beta.realtime.sessions.create({
            model: 'gpt-4o-realtime-preview',
            voice: voice,
            modalities: ['audio', 'text'],
            instructions: instructions || `You are a knowledgeable stamp collecting expert specializing in conversational responses for voice synthesis. 

IMPORTANT GUIDELINES:
- Provide natural, conversational responses suitable for speech
- Use clear, descriptive language
- Avoid abbreviations and technical jargon
- Use complete sentences and natural speech patterns
- Be informative but friendly and engaging
- When describing stamps, include details like country, year, denomination, color, and interesting facts
- Use natural language for denominations (e.g., "one-third penny" instead of "1/3d")
- Focus on descriptive, engaging content that sounds natural when spoken
- Maintain conversation context from previous messages
- Reference previous topics when relevant to show continuity
- Keep responses concise but informative (2-3 sentences max for voice)
- Always respond in a natural, conversational manner suitable for voice synthesis`,
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
                model: 'whisper-1'
            },
            turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 200
            },
            temperature: 0.8,
            speed: 1.0,
            max_response_output_tokens: 200
        })

        console.log('🎤 Realtime session created:', (session as any).id)

        // According to the reference project, we need to generate WebRTC SDP information
        // The backend should handle the WebRTC connection, not just return a WebSocket URL

        // For now, let's return the session info that the frontend can use
        // The frontend will need to establish a WebRTC connection through our backend
        return NextResponse.json({
            success: true,
            sessionId: (session as any).id,
            clientSecret: (session as any).client_secret?.value,
            // Note: This is not a direct WebSocket URL to OpenAI
            // The frontend should connect to our backend for WebRTC handling
            backendWebRTCUrl: `/api/realtime-webrtc/${(session as any).id}`,
            response: 'Session created successfully, connect via WebRTC for real-time audio streaming'
        })

    } catch (error) {
        console.error('❌ Realtime voice API error:', error)
        return NextResponse.json({
            success: false,
            error: 'Failed to create realtime voice session',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
    }
}
