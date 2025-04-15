const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // You can restrict this to your frontend origin later
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`; // Set BASE_URL in production

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage: storage });

let clients = {};

io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('register', (userId) => {
    clients[userId] = socket.id;
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    for (const userId in clients) {
      if (clients[userId] === socket.id) {
        delete clients[userId];
        break;
      }
    }
    console.log('Client disconnected');
  });
});

app.post('/send-image', upload.single('file'), (req, res) => {
  const { userIDFrom, userIDTo } = req.body;
  const filename = req.file.filename;
  const url = `${BASE_URL}/uploads/${filename}`;

  if (clients[userIDTo]) {
    io.to(clients[userIDTo]).emit('image', {
      from: userIDFrom,
      url: url,
      filename: filename
    });
  }

  res.json({ message: 'Image sent', to: userIDTo, url });
});

server.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
