import { Router } from 'express';
import cloudinary from 'cloudinary';

const router = Router();

// Configure cloudinary from env (safe to call here; secrets come from server .env)
cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// GET /api/uploads/sign?folder=optional
router.get('/sign', (req, res) => {
  try {
    const folder = req.query.folder || process.env.CLOUDINARY_DEFAULT_FOLDER || 'chitz';
    const timestamp = Math.floor(Date.now() / 1000);
    // Only sign selected params (folder and timestamp). Add transformations here if needed.
    const paramsToSign = { folder, timestamp };
    const signature = cloudinary.v2.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
    return res.json({ signature, api_key: process.env.CLOUDINARY_API_KEY, timestamp, folder });
  } catch (err) {
    console.error('Failed to sign upload request', err);
    return res.status(500).json({ message: 'Failed to create upload signature' });
  }
});

export default router;
