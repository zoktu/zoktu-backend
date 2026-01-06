import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  senderId: { type: String, required: true, index: true },
  senderName: { type: String },
  content: { type: String, required: true },
  type: { type: String, default: 'text' },
  replyTo: { type: String },
  createdAt: { type: Date, default: Date.now },
  editedAt: { type: Date },
  reactions: [{ emoji: String, userId: String, createdAt: Date }],
  meta: { type: Object }
});

// Separate collections for different chat types
const RoomMessage = mongoose.models.RoomMessage || mongoose.model('RoomMessage', MessageSchema, 'room_messages');
const DMMessage = mongoose.models.DMMessage || mongoose.model('DMMessage', MessageSchema, 'dm_messages');
const RandomMessage = mongoose.models.RandomMessage || mongoose.model('RandomMessage', MessageSchema, 'random_messages');

const getModelForRoom = (room) => {
  // room may be null/undefined -> default to RoomMessage
  try {
    if (!room) return RoomMessage;
    // Random chat is stored separately
    if (room.category === 'random') return RandomMessage;

    // DMs: older data sometimes uses type 'private' with category 'dm'
    const isDM = room.type === 'dm' || room.category === 'dm' || room.isDM === true || room.isDirect === true;
    if (isDM) return DMMessage;

    return RoomMessage;
  } catch (e) {
    return RoomMessage;
  }
};

export { RoomMessage, DMMessage, RandomMessage, getModelForRoom };
export default getModelForRoom;
