
const express = require('express');
const { handlePhilaguideRequest, getPhilaguideHealth } = require('../controllers/philaguideController');
const { upload, handleImageSearchRequest } = require('../controllers/imageSearchController');
const { handleRealtimeSessionRequest } = require('../controllers/realtimeSessionController');
const { handleRealtimeStreamRequest } = require('../controllers/realtimeStreamController');
const { handleRealtimeVoiceRequest } = require('../controllers/realtimeVoiceController');
const { handleSpeechToTextRequest } = require('../controllers/speechToTextController');
const { handleVoiceChatRequest, getVoiceChatTest } = require('../controllers/voiceChatController');
const { handleVoiceStampSearchRequest } = require('../controllers/voiceStampSearchController');
const { handleVoiceSynthesisRequest } = require('../controllers/voiceSynthesisController');
const { getAvailableVoices } = require('../controllers/voiceSynthesisController');
const { postRealtimeWebrtc, putRealtimeWebrtc, getRealtimeWebsocketReady } = require('../controllers/realtimeWebrtcController');

const router = express.Router();

router.get('/', (req, res) => {
  res.send('Node.js Backend is running!');
});

// Health check for philaguide (matches Next.js GET)
router.get('/api/philaguide', getPhilaguideHealth);
router.post('/api/philaguide', handlePhilaguideRequest);

router.post('/api/search-by-image', upload.single('image'), handleImageSearchRequest);

router.post('/api/realtime-session', handleRealtimeSessionRequest);

router.post('/api/realtime-stream', handleRealtimeStreamRequest);

router.post('/api/realtime-voice', handleRealtimeVoiceRequest);

// Realtime WebRTC endpoints (to mirror Next.js api/realtime-webrtc/[sessionId])
router.post('/api/realtime-webrtc/:sessionId', postRealtimeWebrtc);
router.put('/api/realtime-webrtc/:sessionId', putRealtimeWebrtc);
router.get('/api/realtime-webrtc/:sessionId/websocket', getRealtimeWebsocketReady);

router.post('/api/speech-to-text', handleSpeechToTextRequest);

// Voice chat endpoints
router.get('/api/voice-chat', getVoiceChatTest);
router.post('/api/voice-chat', handleVoiceChatRequest);

router.post('/api/voice-stamp-search', handleVoiceStampSearchRequest);

router.post('/api/voice-synthesis', handleVoiceSynthesisRequest);
router.get('/api/voice-synthesis', getAvailableVoices);

module.exports = router;
