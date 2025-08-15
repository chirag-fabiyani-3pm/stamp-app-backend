const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function handleVoiceSynthesisRequest(req, res) {
    try {
        const { text, voice = 'alloy' } = req.body;

        console.log('🎤 Voice synthesis request:', {
            textLength: text.length,
            voice
        });

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        const selectedVoice = validVoices.includes(voice) ? voice : 'alloy';

        const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: selectedVoice,
            input: text,
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());

        console.log('🎤 Voice synthesis completed:', buffer.length, 'bytes');

        return res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': buffer.length.toString(),
        }).end(buffer);

    } catch (error) {
        console.error('❌ Voice synthesis error:', error);
        return res.status(500).json({
            error: 'Failed to synthesize speech'
        });
    }
}

async function getAvailableVoices(req, res) {
    const voices = [
        { id: 'alloy', name: 'Alloy', description: 'Balanced and versatile voice' },
        { id: 'echo', name: 'Echo', description: 'Clear and professional voice' },
        { id: 'fable', name: 'Fable', description: 'Warm and storytelling voice' },
        { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative voice' },
        { id: 'nova', name: 'Nova', description: 'Bright and energetic voice' },
        { id: 'shimmer', name: 'Shimmer', description: 'Smooth and melodic voice' }
    ];

    return res.json({ voices });
}

module.exports = {
    handleVoiceSynthesisRequest,
    getAvailableVoices,
};
