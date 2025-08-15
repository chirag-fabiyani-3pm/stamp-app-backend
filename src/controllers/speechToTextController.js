const { unlinkSync, writeFileSync } = require('fs');
const OpenAI = require('openai');
const { tmpdir } = require('os');
const { join } = require('path');

// Add global File constructor that OpenAI requires
if (typeof globalThis.File === 'undefined') {
    const { File } = require('node:buffer');
    globalThis.File = File;
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function handleSpeechToTextRequest(req, res) {
    let tempFilePath = null;

    try {
        const { audio, sessionId } = req.body;

        if (!audio) {
            console.error('❌ No audio data provided');
            return res.status(400).json({
                error: 'No audio data provided'
            });
        }

        console.log('🎤 Speech-to-text request received, audio length:', audio.length);

        try {
            const audioBuffer = Buffer.from(audio, 'base64');
            console.log('🎤 Audio buffer size:', audioBuffer.length, 'bytes');

            if (audioBuffer.length < 100) {
                console.warn('⚠️ Audio buffer too small, likely test data');
                return res.json({
                    text: "This appears to be test data. Please provide actual audio recording.",
                    error: 'test_data_detected'
                });
            }

            const tempFileName = `audio_${Date.now()}.webm`;
            tempFilePath = join(tmpdir(), tempFileName);

            writeFileSync(tempFilePath, audioBuffer);
            console.log('🎤 Temporary file created:', tempFilePath);

            const audioFile = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' });
            console.log('🎤 File object created:', audioFile.size, 'bytes');

            const transcription = await openai.audio.transcriptions.create({
                file: audioFile,
                model: 'whisper-1',
                language: 'en',
                response_format: 'text'
            });

            console.log('🎤 Transcription completed:', transcription.substring(0, 50) + '...');
            return res.json({ text: transcription });

        } catch (whisperError) {
            console.error('❌ Whisper API error:', whisperError);

            return res.json({
                text: "I heard you speak, but I'm having trouble understanding the words. Please try speaking more clearly or try again.",
                error: 'whisper_api_failed',
                details: whisperError instanceof Error ? whisperError.message : 'Unknown error'
            });
        }

    } catch (error) {
        console.error('❌ Speech-to-text error:', error);
        return res.status(500).json({
            text: "Sorry, I couldn't process your voice. Please try again.",
            error: 'processing_failed',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    } finally {
        if (tempFilePath) {
            try {
                unlinkSync(tempFilePath);
                console.log('🎤 Temporary file cleaned up');
            } catch (cleanupError) {
                console.warn('⚠️ Failed to clean up temp file:', cleanupError);
            }
        }
    }
}

module.exports = {
    handleSpeechToTextRequest,
};
