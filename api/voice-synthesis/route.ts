import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

// OpenAI Voice Synthesis endpoint
export async function POST(request: NextRequest) {
    try {
        const { text, voice = 'alloy' } = await request.json()

        console.log('🎤 Voice synthesis request:', {
            textLength: text.length,
            voice
        })

        if (!text) {
            return NextResponse.json({ error: 'Text is required' }, { status: 400 })
        }

        // Available OpenAI voices: alloy, echo, fable, onyx, nova, shimmer
        const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
        const selectedVoice = validVoices.includes(voice) ? voice : 'alloy'

        // Create speech synthesis
        const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: selectedVoice as any,
            input: text,
        })

        // Convert to buffer
        const buffer = Buffer.from(await mp3.arrayBuffer())

        console.log('🎤 Voice synthesis completed:', buffer.length, 'bytes')

        // Return audio as MP3
        return new NextResponse(buffer, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': buffer.length.toString(),
            },
        })

    } catch (error) {
        console.error('❌ Voice synthesis error:', error)
        return NextResponse.json({
            error: 'Failed to synthesize speech'
        }, { status: 500 })
    }
}

// Get available voices
export async function GET() {
    const voices = [
        { id: 'alloy', name: 'Alloy', description: 'Balanced and versatile voice' },
        { id: 'echo', name: 'Echo', description: 'Clear and professional voice' },
        { id: 'fable', name: 'Fable', description: 'Warm and storytelling voice' },
        { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative voice' },
        { id: 'nova', name: 'Nova', description: 'Bright and energetic voice' },
        { id: 'shimmer', name: 'Shimmer', description: 'Smooth and melodic voice' }
    ]

    return NextResponse.json({ voices })
} 