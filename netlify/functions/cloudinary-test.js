import { handleCors, success, error, requireAuth } from '../../shared/middleware.js';
import { cloudinary, uploadImage } from '../../shared/cloudinary.js';

export const handler = async (event, context) => {
  const cors = handleCors(event);
  if (cors) return cors;

  try {
    // Require admin auth because this endpoint burns API/Storage limits for testing
    try { 
      requireAuth(event); 
    } catch (e) { 
      return error(e.message || 'Unauthorized', event, 401); 
    }

    const diagnostics = {
      timestamp: new Date().toISOString()
    };
    
    // 1. Ping Cloudinary API to verify credentials are fundamentally sound
    try {
      const ping = await cloudinary.api.ping();
      diagnostics.cloudinary_ping = ping;
    } catch (e) { 
      diagnostics.cloudinary_ping = { error: e.message }; 
    }

    // 2. Try a small image upload from a remote URL to test actual write access permissions
    try {
      const sampleUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/No_image_available.svg/240px-No_image_available.svg.png';
      
      const res = await uploadImage(sampleUrl, { 
        folder: 'yaard/tests', 
        public_id: `test_upload_${Date.now()}` 
      });
      
      diagnostics.upload_result = { 
        status: "success",
        public_id: res.public_id, 
        version: res.version, 
        secure_url: res.secure_url 
      };
      
      // Immediately clean up the test file so it doesn't clutter storage or billing
      await cloudinary.uploader.destroy(res.public_id, { invalidate: true });
      diagnostics.cleanup = "success";
      
    } catch (e) { 
      diagnostics.upload_result = { error: e.message }; 
      diagnostics.cleanup = "bypassed due to upload failure";
    }

    return success(diagnostics, event);
  } catch (err) {
    console.error('[cloudinary-test] Critical Error:', err);
    return error(err.message || 'Internal error processing the Cloudinary upload test.', event, 500);
  }
};