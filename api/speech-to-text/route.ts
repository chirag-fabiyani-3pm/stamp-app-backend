import { unlinkSync, writeFileSync } from 'fs'
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { tmpdir } from 'os'
import { join } from 'path'

// Add global File constructor that OpenAI requires
if (typeof globalThis.File === 'undefined') {
    const { File } = require('node:buffer')
    globalThis.File = File
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

export async function POST(request: NextRequest) {
    let tempFilePath: string | null = null

    try {
        const { audio, sessionId } = await request.json()

        if (!audio) {
            console.error('❌ No audio data provided')
            return NextResponse.json({
                error: 'No audio data provided'
            }, { status: 400 })
        }

        console.log('🎤 Speech-to-text request received, audio length:', audio.length)

        try {
            // Convert base64 to buffer
            const audioBuffer = Buffer.from(audio, 'base64')
            console.log('🎤 Audio buffer size:', audioBuffer.length, 'bytes')

            // Validate audio buffer size
            if (audioBuffer.length < 100) {
                console.warn('⚠️ Audio buffer too small, likely test data')
                return NextResponse.json({
                    text: "This appears to be test data. Please provide actual audio recording.",
                    error: 'test_data_detected'
                })
            }

            // Create a temporary file for OpenAI
            const tempFileName = `audio_${Date.now()}.webm`
            tempFilePath = join(tmpdir(), tempFileName)

            // Write audio buffer to temporary file
            writeFileSync(tempFilePath, audioBuffer)
            console.log('🎤 Temporary file created:', tempFilePath)

            // Create a proper File object that OpenAI expects
            const audioFile = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' })
            console.log('🎤 File object created:', audioFile.size, 'bytes')

            // Send to OpenAI Whisper using the File object
            const transcription = await openai.audio.transcriptions.create({
                file: audioFile,
                model: 'whisper-1',
                language: 'en',
                response_format: 'text'
            })

            console.log('🎤 Transcription completed:', transcription.substring(0, 50) + '...')
            return NextResponse.json({ text: transcription })

        } catch (whisperError) {
            console.error('❌ Whisper API error:', whisperError)

            return NextResponse.json({
                text: "I heard you speak, but I'm having trouble understanding the words. Please try speaking more clearly or try again.",
                error: 'whisper_api_failed',
                details: whisperError instanceof Error ? whisperError.message : 'Unknown error'
            })
        }

    } catch (error) {
        console.error('❌ Speech-to-text error:', error)
        return NextResponse.json({
            text: "Sorry, I couldn't process your voice. Please try again.",
            error: 'processing_failed',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
    } finally {
        // Clean up temporary file
        if (tempFilePath) {
            try {
                unlinkSync(tempFilePath)
                console.log('🎤 Temporary file cleaned up')
            } catch (cleanupError) {
                console.warn('⚠️ Failed to clean up temp file:', cleanupError)
            }
        }
    }
}
