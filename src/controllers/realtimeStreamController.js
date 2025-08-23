const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function handleRealtimeStreamRequest(req, res) {
    try {
        const { voice = 'alloy', instructions } = req.body;

        console.log('🎤 Creating Realtime streaming session with voice:', voice);

        // Create a Realtime session with OpenAI
        const session = await openai.beta.realtime.sessions.create({
            model: 'gpt-4o-realtime-preview-2025-06-03',
            voice: voice,
            instructions: instructions || `You are a knowledgeable stamp collecting expert. Answer questions about stamps, their history, and collecting. Keep responses concise and helpful. You can search for stamps using the available functions.`
        });

        console.log('🎤 Realtime session created:', session.id);
        console.log('🎤 Session object:', JSON.stringify(session, null, 2));
        console.log('🎤 Client secret type:', typeof session.client_secret);
        console.log('🎤 Client secret value:', session.client_secret);

        // Return the session info for the client to connect to
        return res.json({
            success: true,
            sessionId: session.id,
            client_secret: session.client_secret,
            // The client will connect directly to OpenAI's WebSocket endpoint
            websocketUrl: `wss://api.openai.com/v1/realtime/sessions/${session.id}/stream`
        });

    } catch (error) {
        console.error('❌ Failed to create Realtime session:', error);
        return res.status(500).json({
            error: 'Failed to create Realtime session',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
}

module.exports = {
    handleRealtimeStreamRequest,
};
