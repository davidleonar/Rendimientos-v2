// next.config.js


/** @type {import('next').NextConfig} */
const nextConfig = {
  // Remove this line → output: 'export',
  // Optional: silence lockfile warning
  //output: 'export',  // CRITICAL: Enables static export
  //trailingSlash: true,
  //images: { unoptimized: true },  // Required for static export

  outputFileTracingRoot: '/Users/davidpaniagua/Documents/my-project/my-spa',

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