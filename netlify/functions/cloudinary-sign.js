import { handleCors, success, error, requireAuth } from '../../shared/middleware.js';
import { generateUploadSignature } from '../../shared/cloudinary.js';

export const handler = async (event, context) => {
  const cors = handleCors(event);
  if (cors) return cors;

  try {
    // We enforce authentication for signature issuance so anonymous 
    // scrapers cannot steal upload tokens to fill up your Cloudinary storage.
    let userId;
    try { 
      ({ userId } = requireAuth(event)); 
    } catch (e) { 
      return error(e.message || 'Unauthorized: Only active user sessions can request upload signatures.', event, 401); 
    }

    const params = event.queryStringParameters || {};
    
    // Front-end clients can specify exactly where they want to upload, 
    // defaulting to the authenticated user's upload folder if not provided.
    const resourceType = params.resourceType || 'video';
    const folder = params.folder || `yaard/users/${userId}/${resourceType}`;
    
    const additionalParams = {};
    // If you ever need to allow clients to pass specific eager transformations
    // via query parameters, you would map them here.

    // Generate the cryptographic signature using the shared helper
    const signaturePayload = generateUploadSignature(folder, resourceType, additionalParams);
    
    return success(signaturePayload, event);
  } catch (err) {
    console.error('[cloudinary-sign] Error generating upload signature payload:', err);
    return error(err.message || 'Internal server error while processing Cloudinary cryptographic signature.', event, 500);
  }
};