const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes'); // Import the routes module

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for image uploads

// Use the routes
app.use('/', routes);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
}); 