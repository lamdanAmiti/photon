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
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || ""; // Can be set in Render environment

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
const userFilePath = path.join(__dirname, 'users.txt');

io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('register', (userId) => {
    clients[userId] = socket.id;
    console.log(`User ${userId} registered with socket ${socket.id}`);

    // Append to file
    fs.appendFileSync(userFilePath, `${new Date().toISOString()} - Registered: ${userId}\n`);
  });

  socket.on('disconnect', () => {
    for (const userId in clients) {
      if (clients[userId] === socket.id) {
        fs.appendFileSync(userFilePath, `${new Date().toISOString()} - Disconnected: ${userId}\n`);
        delete clients[userId];
        break;
      }
    }
    console.log('Client disconnected');
  });
});

app.post('/send-image', upload.single('file'), (req, res) => {
  try {
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
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get('/logs', (req, res) => {
  fs.readFile(userFilePath, 'utf8', (err, data) => {
    if (err) return res.status(500).send("Could not read logs.");
    res.type('text/plain').send(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
