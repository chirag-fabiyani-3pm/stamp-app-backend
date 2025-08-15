
const express = require('express');
const { handlePhilaguideRequest } = require('../controllers/philaguideController');
const { upload, handleImageSearchRequest } = require('../controllers/imageSearchController');
const { handleRealtimeSessionRequest } = require('../controllers/realtimeSessionController');
const { handleRealtimeStreamRequest } = require('../controllers/realtimeStreamController');
const { handleRealtimeVoiceRequest } = require('../controllers/realtimeVoiceController');
const { handleSpeechToTextRequest } = require('../controllers/speechToTextController');
const { handleVoiceChatRequest } = require('../controllers/voiceChatController');
const { handleVoiceStampSearchRequest } = require('../controllers/voiceStampSearchController');
const { handleVoiceSynthesisRequest } = require('../controllers/voiceSynthesisController');
const { getAvailableVoices } = require('../controllers/voiceSynthesisController');

const router = express.Router();

router.get('/', (req, res) => {
  res.send('Node.js Backend is running!');
});

router.post('/api/philaguide', handlePhilaguideRequest);

router.post('/api/search-by-image', upload.single('image'), handleImageSearchRequest);

router.post('/api/realtime-session', handleRealtimeSessionRequest);

router.post('/api/realtime-stream', handleRealtimeStreamRequest);

router.post('/api/realtime-voice', handleRealtimeVoiceRequest);

router.post('/api/speech-to-text', handleSpeechToTextRequest);

router.post('/api/voice-chat', handleVoiceChatRequest);

router.post('/api/voice-stamp-search', handleVoiceStampSearchRequest);

router.post('/api/voice-synthesis', handleVoiceSynthesisRequest);
router.get('/api/voice-synthesis', getAvailableVoices);

module.exports = router;
