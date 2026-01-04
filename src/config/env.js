import dotenv from 'dotenv';

dotenv.config();

const buildMongoUri = () => {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  const host = process.env.MONGO_HOST;
  const db = process.env.MONGO_DB || 'chitz';
  if (user && pass && host) {
    return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${db}?retryWrites=true&w=majority`;
  }
  return 'mongodb://localhost:27017/chitz';
};

export const env = {
  port: process.env.PORT || 4000,
  mongoUri: buildMongoUri(),
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173'
};
