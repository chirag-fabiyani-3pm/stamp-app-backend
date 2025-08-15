
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = 'asst_AfsiDbpnx2WjgZV7O97eHhyb';
const TIMEOUT_MS = 12000;

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

module.exports = {
    openai,
    ASSISTANT_ID,
    TIMEOUT_MS,
};
