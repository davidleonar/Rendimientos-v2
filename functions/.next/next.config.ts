// next.config.js


/** @type {import('next').NextConfig} */
const nextConfig = {
  // Remove this line → output: 'export',
  // Optional: silence lockfile warning
  //output: 'export',  // CRITICAL: Enables static export
  //trailingSlash: true,
  //images: { unoptimized: true },  // Required for static export

  outputFileTracingRoot: '/Users/davidpaniagua/Documents/my-project/my-spa',

  env: {
    NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyBk_fTMgmkwZGoW154ntCxxXwiDMy5o7KA",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "rendimientos-5dbb9.firebaseapp.com",
    NEXT_PUBLIC_FIREBASE_DB_URL: "https://rendimientos-5dbb9-default-rtdb.firebaseio.com",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "rendimientos-5dbb9",
    NEXT_PUBLIC_FIREBASE_STRG_BUCKET: "rendimientos-5dbb9.firebasestorage.app",
    NEXT_PUBLIC_FIREBASE_MSID: "698366956468",
    NEXT_PUBLIC_FIREBASE_APP_ID: "1:698366956468:web:18ae8758f5f3c4fe5dd8e1",
    NEXT_PUBLIC_FIREBASE_MSM_ID: "G-Y5QKXN0N6C",
  },

  async headers() {
    if (process.env.NODE_ENV === 'development') {
      return [
        {
          source: '/_next/:path*',
          headers: [
            { key: 'Access-Control-Allow-Origin', value: '*' },
          ],
        },
      ];
    }
    return [];
  },
 // Fix TLS in dev
 experimental: {
  // This tells Next.js to trust system CAs
  // Works in Turbopack + dev server
  //server: {https: true}
},

// Critical: Use node-fetch with proper TLS
// Or better: use native fetch (Next.js 15+ supports it)
};

export default nextConfig;