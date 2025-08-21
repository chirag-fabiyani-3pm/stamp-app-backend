const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory sessions (simple parity with Next.js file)
const activeSessions = new Map();

async function postRealtimeWebrtc(req, res) {
    try {
        const { sessionId } = req.params;
        const { clientSecret, voice, instructions } = req.body || {};

        if (!clientSecret) {
            return res.status(400).json({ success: false, error: 'Client secret is required' });
        }

        let openaiSession;
        try {
            openaiSession = await openai.beta.realtime.sessions.create({
                voice: voice || 'alloy',
                model: 'gpt-4o-realtime-preview',
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
            });

            activeSessions.set(sessionId, {
                openaiSessionId: openaiSession.id || sessionId,
                clientSecret,
                createdAt: new Date(),
                voice: voice || 'alloy',
                instructions: instructions || ''
            });

        } catch (error) {
            console.error('🎤 WebRTC POST: Failed to create OpenAI session:', error);
            return res.status(500).json({ success: false, error: 'Failed to create OpenAI session' });
        }

        return res.json({
            success: true,
            sessionId,
            openaiSessionId: openaiSession.id || sessionId,
            message: 'OpenAI Realtime session created, ready for voice chat via backend proxy'
        });
    } catch (error) {
        console.error('🎤 WebRTC POST: Error:', error);
        return res.status(500).json({ success: false, error: 'Failed to process request' });
    }
}

async function putRealtimeWebrtc(req, res) {
    try {
        const { sessionId } = req.params;
        const { audioData, messageType } = req.body || {};

        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        if (messageType === 'session.update') {
            const { sessionUpdate } = req.body || {};
            activeSessions.set(sessionId, { ...session, voice: sessionUpdate?.voice, instructions: sessionUpdate?.instructions });
            return res.json({ success: true, message: 'Session updated successfully' });
        }

        if (messageType === 'input_audio_buffer.append') {
            const audioLength = audioData?.length || 0;
            const timestamp = new Date().toISOString();

            let aiResponse;
            if (audioLength < 5000) {
                aiResponse = "I heard your brief question about stamps. Could you speak a bit longer so I can better understand?";
            } else if (audioLength < 20000) {
                aiResponse = "Thanks for the question! Stamps tell stories about countries and people. What specific aspect interests you?";
            } else if (audioLength < 50000) {
                aiResponse = "Great question! I can help with identification, values, preservation, and history. Where should we start?";
            } else if (audioLength < 100000) {
                aiResponse = "Comprehensive inquiry! I can assist with advanced identification, market trends, and conservation. Which area first?";
            } else {
                aiResponse = "Deep philatelic dive! We can explore authentication, research methods, and investment strategies. Which topic?";
            }

            return res.json({
                success: true,
                response: {
                    type: 'response.text.delta',
                    delta: aiResponse,
                    audioLength,
                    timestamp,
                    openaiSessionId: session.openaiSessionId,
                    note: 'Simulated response - OpenAI integration pending'
                },
                message: `Audio processed with simulated OpenAI response (${audioLength} chars)`
            });
        }

        return res.json({ success: true, message: 'Message processed successfully' });
    } catch (error) {
        console.error('🎤 WebRTC PUT: Error:', error);
        return res.status(500).json({ success: false, error: 'Failed to process message' });
    }
}

function getRealtimeWebsocketReady(req, res) {
    // Placeholder to indicate the WebSocket path readiness
    return res.status(200).send('WebSocket endpoint ready for OpenAI integration');
}

module.exports = {
    postRealtimeWebrtc,
    putRealtimeWebrtc,
    getRealtimeWebsocketReady,
};


