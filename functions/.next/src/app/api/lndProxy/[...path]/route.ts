// src/app/api/lndProxy/[...path]/route.ts
import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface LndInvoiceRequest {
  value_msat: number;
  memo?: string;
  expiry?: string;
  private?: boolean;
}

/* ------------------------------------------------------------------ */
/*  POST – create invoice                                            */
/* ------------------------------------------------------------------ */
export async function POST(req: NextRequest) {
  const { pathname, search } = new URL(req.url);
  const lndPath = pathname.replace(/^\/api\/lndProxy/, '') + search;

  const proxyUrl = `https://us-central1-rendimientos-5dbb9.cloudfunctions.net/lndProxy?path=${lndPath}`;

  console.log('POST → Firebase:', proxyUrl);

  try {
    const headers = new Headers(req.headers);
    headers.set('Content-Type', 'application/json');

    let payload: LndInvoiceRequest | null = null;
    if (req.method === 'POST') {
      try { payload = await req.json(); }
      catch {
        return new NextResponse(
          JSON.stringify({ error: 'Invalid JSON body' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log('Body:', payload);

    const firebaseResp = await fetch(proxyUrl, {
      method: 'POST',
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const clone = firebaseResp.clone();
    let data: unknown;
    try { data = await firebaseResp.json(); }
    catch {
      const txt = await clone.text();
      console.error('Non-JSON from Firebase:', txt);
      return new NextResponse(
        JSON.stringify({ error: 'Invalid proxy response', details: txt }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!firebaseResp.ok) {
      console.error('LND Proxy Error:', firebaseResp.status, data);
      return new NextResponse(
        JSON.stringify({ error: 'LND Proxy failed', details: data }),
        { status: firebaseResp.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('POST proxy error:', msg);
    return new NextResponse(
      JSON.stringify({ error: 'Internal error', details: msg }),
      { status: 500, headers: { 'Content c-Type': 'application/json' } }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  GET – lookup invoice                                             */
/* ------------------------------------------------------------------ */
export async function GET(req: NextRequest) {
  const { pathname, search } = new URL(req.url);
  const lndPath = pathname.replace(/^\/api\/lndProxy/, '') + search;

  const proxyUrl = `https://us-central1-rendimientos-5dbb9.cloudfunctions.net/lndProxy?path=${lndPath}`;

  console.log('GET → Firebase:', proxyUrl);

  try {
    const firebaseResp = await fetch(proxyUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const clone = firebaseResp.clone();
    let data: unknown;
    try { data = await firebaseResp.json(); }
    catch {
      const txt = await clone.text();
      console.error('Non-JSON from Firebase:', txt);
      return new NextResponse(
        JSON.stringify({ error: 'Invalid proxy response', details: txt }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!firebaseResp.ok) {
      console.error('LND error:', firebaseResp.status, data);
      return new NextResponse(
        JSON.stringify({ error: 'LND failed', details: data }),
        { status: firebaseResp.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('GET proxy error:', msg);
    return new NextResponse(
      JSON.stringify({ error: 'Internal error', details: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  HEAD – for CORS preflight (optional but clean)                   */
/* ------------------------------------------------------------------ */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}