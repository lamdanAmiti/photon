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
const BASE_URL = process.env.BASE_URL || "https://photon-xz0s.onrender.com";

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const usersDB = path.join(__dirname, 'users.json');
const messagesDB = path.join(__dirname, 'messages.json');

if (!fs.existsSync(usersDB)) fs.writeFileSync(usersDB, JSON.stringify({}));
if (!fs.existsSync(messagesDB)) fs.writeFileSync(messagesDB, JSON.stringify([]));

const getUsers = () => JSON.parse(fs.readFileSync(usersDB, 'utf8'));
const saveUsers = (users) => fs.writeFileSync(usersDB, JSON.stringify(users, null, 2));
const getMessages = () => JSON.parse(fs.readFileSync(messagesDB, 'utf8'));
const saveMessages = (msgs) => fs.writeFileSync(messagesDB, JSON.stringify(msgs, null, 2));

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

let sockets = {};

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('register', (userId) => {
    sockets[userId] = socket.id;
    console.log(`Registered user ${userId} with socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    for (let uid in sockets) {
      if (sockets[uid] === socket.id) {
        delete sockets[uid];
        console.log(`Disconnected: ${uid}`);
        break;
      }
    }
  });
});

app.post('/register', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const users = getUsers();
  if (users[userId]) {
    return res.status(400).json({ error: 'User already exists' });
  }

  users[userId] = { userId };
  saveUsers(users);
  res.json({ message: 'Registered successfully' });
});

app.post('/login', (req, res) => {
  const { userId } = req.body;
  const users = getUsers();
  if (!users[userId]) return res.status(401).json({ error: 'User not found' });
  res.json({ message: 'Login successful' });
});

app.get('/users', (req, res) => {
  const users = getUsers();
  res.json(Object.keys(users));
});

app.get('/online-users', (req, res) => {
  res.json(Object.keys(sockets));
});

app.get('/images', (req, res) => {
  res.json(getMessages());
});

app.post('/send-image', upload.single('file'), (req, res) => {
  try {
    const { userIDFrom, userIDTo } = req.body;
    const filename = req.file.filename;
    const url = `${BASE_URL}/uploads/${filename}`;

    const msg = {
      from: userIDFrom,
      to: userIDTo,
      url,
      filename,
      timestamp: Date.now()
    };

    const messages = getMessages();
    messages.push(msg);
    saveMessages(messages);

    if (sockets[userIDTo]) {
      io.to(sockets[userIDTo]).emit('image', msg);
    }

    res.json({ message: 'Image sent', to: userIDTo, url });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
