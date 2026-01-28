import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",   // later restrict to your frontend domain
    methods: ["GET", "POST"]
  }
});

// In-memory rooms
const rooms = new Map(); // roomId -> messages[]

function generateRoomId(){
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

io.on("connection", (socket) => {
  console.log("🔗 User connected:", socket.id);

  // Create room
  socket.on("room:create", () => {
    let roomId;
    do {
      roomId = generateRoomId();
    } while (rooms.has(roomId));

    rooms.set(roomId, []);
    socket.join(roomId);

    console.log("🆕 Room created:", roomId);
    socket.emit("room:created", { roomId });
  });

  // Join room
  socket.on("room:join", ({ roomId }) => {
    console.log("➡️ Join request:", roomId);

    if(!rooms.has(roomId)){
      socket.emit("room:error", "Room not found");
      return;
    }

    socket.join(roomId);
    socket.emit("room:messages", rooms.get(roomId));
  });

  // Send code
  socket.on("code:send", ({ roomId, code }) => {
    const message = {
      id: Date.now(),
      code,
      time: new Date().toISOString()
    };

    rooms.get(roomId)?.push(message);
    io.to(roomId).emit("code:new", message);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

// Health route (Render check)
app.get("/", (req, res) => {
  res.send("CodeChange Backend Running 🚀");
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
