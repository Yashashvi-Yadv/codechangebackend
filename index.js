import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();

/* ---------- HTTP SERVER ---------- */
const httpServer = http.createServer(app);

/* ---------- EXPRESS CORS ---------- */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
}));

/* ---------- SOCKET.IO SERVER ---------- */
const io = new Server(httpServer, {
  path: "/socket.io",   // IMPORTANT
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["polling", "websocket"]
});

/* ---------- ROOM STORE ---------- */
const rooms = new Map();

function generateRoomId(){
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ---------- SOCKET EVENTS ---------- */
io.on("connection", (socket) => {
  console.log("🔗 User connected:", socket.id);

  socket.on("room:create", () => {
    let id;
    do { id = generateRoomId(); } while (rooms.has(id));

    rooms.set(id, []);
    socket.join(id);

    console.log("🆕 Room created:", id);
    socket.emit("room:created", { roomId: id });
  });

  socket.on("room:join", ({ roomId }) => {
    console.log("➡️ Join:", roomId);

    if (!rooms.has(roomId)) {
      socket.emit("room:error", "Room not found");
      return;
    }

    socket.join(roomId);
    socket.emit("room:messages", rooms.get(roomId));
  });

  socket.on("code:send", ({ roomId, code }) => {
    const msg = { id: Date.now(), code };
    rooms.get(roomId)?.push(msg);
    io.to(roomId).emit("code:new", msg);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected");
  });
});

/* ---------- TEST ROUTE ---------- */
app.get("/", (req,res)=>{
  res.status(200).json({
    message:"backend is running"
  })

});

/* ---------- START ---------- */
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
