const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const routes = require('./routes'); // Import the routes module
const { attachOpenAIWebSocketServer } = require('../server/websocket-server');

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for image uploads

// Use the routes
app.use('/', routes);

// Create HTTP server and attach WebSocket server to the same port
const server = http.createServer(app);
attachOpenAIWebSocketServer(server);

server.listen(port, () => {
  console.log(`HTTP + WebSocket server listening on port ${port}`);
});