"use client";
import { useState, useEffect } from "react";
import '../app/globals.css';
import { ArrowsUpDownIcon } from '@heroicons/react/24/outline';
import { QRCodeCanvas } from 'qrcode.react';  // Use named export

export const dynamic = 'force-dynamic';

// Interface for balance data (from getDataById)
interface SpreadsheetRow {
  id: string;
  name: string;
  lastname: string;
  BTCbalance: string;
  COPbalance: string;
  Rendimiento: string;
  AvgCompra: string;
  [key: string]: string | null;
}

// Interface for movement data (from getMovementsById)
interface MovementRow {
  id: string;
  Fecha: string;
  'Saldo COP': string;
  'Precio BTC': string;
  'Precio Dolar': string;
  Total: string;
  Operacion: string;
  [key: string]: string | null;
}

// Interface for invoices
interface InvoiceStatus {
  r_hash: string;  // Base64-encoded hash (for verification)
  state: number;   // 2 = SETTLED (per LND enum: https://docs.lightning.engineering/reference/types?ref=docs.lightning.engineering#InvoiceState)
  settled: boolean;
  settle_date: string;  // Unix timestamp when settled
  amt_paid_sat: string; // Amount paid in satoshis
  // ... other fields as needed
}

export default function Home() {
  const [id, setId] = useState<string>("");
  const [data, setData] = useState<SpreadsheetRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // State for BTC/USD price tracking
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  // State for sort order in movements
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // States for donations
  const [donationAmount, setDonationAmount] = useState<number>(0);
  const [bolt11, setBolt11] = useState<string | null>(null);
  const [paymentHash, setPaymentHash] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'settled' | null>(null);
  const [donationError, setDonationError] = useState<string | null>(null);

  // State for copy button
  const [copyButtonText, setCopyButtonText] = useState<string>("Copy Payment Request");

  // Proxy URL from env
  //const proxyUrl = process.env.LND_PROXY_URL || 'https://us-central1-rendimientos-5dbb9.cloudfunctions.net/lndProxy';

  // Fetch BTC/USD price from CoinGecko API every 30 seconds
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
        );
        if (!response.ok) throw new Error('Failed to fetch price');
        const data = await response.json();
        const newPrice = data.bitcoin.usd;
        setPrevPrice(currentPrice); // Store previous price before updating
        setCurrentPrice(newPrice);
      } catch (err) {
        console.error('Error fetching BTC price:', err);
      }
    };

    fetchPrice(); // Initial fetch
    const interval = setInterval(fetchPrice, 30000); // Fetch every 30 seconds

    return () => clearInterval(interval); // Cleanup on unmount
  }, [currentPrice]);

  // Determine text color based on price change
  const getColorClass = () => {
    if (prevPrice === null || currentPrice === null) return 'text-white';
    return currentPrice > prevPrice
      ? 'text-green-400' // Price increased
      : currentPrice < prevPrice
      ? 'text-red-400'   // Price decreased
      : 'text-white';    // No change
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    setMovements([]); // Reset movements when fetching new balance data
    try {
      const response = await fetch(
        `https://us-central1-rendimientos-5dbb9.cloudfunctions.net/getDataById?id=${id}`,
        { method: "GET" }
      );
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const result = await response.json();
      setData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  };

  const fetchMovements = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `https://us-central1-rendimientos-5dbb9.cloudfunctions.net/getMovementsById?id=${id}`,
        { method: "GET" }
      );
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const result = await response.json();
      setMovements(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch movements");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (id) fetchData();
  };

  const handleMovementsClick = () => {
    if (id) fetchMovements();
  };

  // Handle Sort by Date
  const handleSortByDate = () => {
    const newSortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    setSortOrder(newSortOrder);

    const sortedMovements = [...movements].sort((a, b) => {
      const dateA = new Date(a.Fecha);
      const dateB = new Date(b.Fecha);
      return newSortOrder === 'asc' ? dateA.getTime() - dateB.getTime() : dateB.getTime() - dateA.getTime();
    });

    setMovements(sortedMovements);
  };

  // Handle WhatsApp chat button click
  const handleWhatsAppClick = () => {
    const phoneNumber = "573014375496"; // Replace with your WhatsApp number
    const message = encodeURIComponent("Hola, tengo dudas sobre...");
    window.open(`https://wa.me/${phoneNumber}?text=${message}`, '_blank');
  };


  // Notificaciones para el estado de la factura
  useEffect(() => {
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    if (paymentHash && paymentStatus === 'pending') {
      interval = setInterval(async () => {
        try {
          // Proxy through your existing LND route: /v1/invoice/{paymentHash}
          const res = await fetch(`/api/lndProxy/v1/invoice/${paymentHash}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to check invoice`);
          
          const invoice: InvoiceStatus = await res.json();
          
          // Check settled status (LND uses 'settled' boolean directly)
          if (invoice.settled) {
            setPaymentStatus('settled');
            console.log('Payment settled! Amount:', invoice.amt_paid_sat, 'sats');

            // Show success toast (optional: replace with toast library later)
            alert(`¡Pago recibido! ${Number(invoice.amt_paid_sat)} sats`);

            // Auto-reset after 3 seconds
            setTimeout(() => {
            resetDonation();
            }, 3000);
          }
        } catch (error) {
          console.error('Check status error:', error);
          setDonationError('Failed to check payment status');
          // Don't stop polling on transient errors
        }
      }, 10000); // Poll every 10s
  
      // Timeout after 5 min
      timeout = setTimeout(() => {
        setPaymentStatus(null);
        setDonationError('Payment check timed out');
        clearInterval(interval);
      }, 300000);
    }
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [paymentHash, paymentStatus]);

  // generar la factura
  const generateDonationInvoice = async () => {
    if (donationAmount <= 0) {
      setDonationError('Amount must be greater than 0');
      return;
    }
    setDonationError(null);
    setPaymentStatus('pending');
  
    try {
      const value_msat = donationAmount * 1000;
      const body = {
        value_msat: value_msat,
        memo: 'Donation from App',
        expiry: '300',
        private: false,
        add_index: 1,
      };
      console.log('Sending donation request:', body);
      const res = await fetch('/api/lndProxy/v1/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    
      if (!res.ok) {
        const errorText = await res.text();
        console.error('Proxy error:', errorText);
        throw new Error(`Server error: ${res.status}`);
      }
  
      const data = await res.json();
      setBolt11(data.payment_request);
      setPaymentHash(Buffer.from(data.r_hash, 'base64').toString('hex'));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      setDonationError(message);
      setPaymentStatus(null);
  }
};

  const resetDonation = () => {
    setDonationAmount(0);
    setBolt11(null);
    setPaymentHash(null);
    setPaymentStatus(null);
    setDonationError(null);
  };

  // Maneja el boton de copiar y pegar
  const handleCopyPaymentRequest = async () => {
    if (!bolt11) {
      setCopyButtonText("No Payment Request");
      setTimeout(() => setCopyButtonText("Copy Payment Request"), 2000);
      return;
    }
  
    try {
      // Check if Clipboard API is available
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(bolt11);
        setCopyButtonText("Copied!");
        setTimeout(() => setCopyButtonText("Copy Payment Request"), 2000);
      } else {
        // Fallback for older browsers or non-secure contexts
        const textArea = document.createElement("textarea");
        textArea.value = bolt11;
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand("copy");
          setCopyButtonText("Copied!");
          setTimeout(() => setCopyButtonText("Copy Payment Request"), 2000);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          throw new Error("Clipboard copy failed via fallback");
        } finally {
          document.body.removeChild(textArea);
        }
      }
    } catch (err) {
      console.error("Clipboard error:", err);
      setCopyButtonText("Copy Failed");
      setTimeout(() => setCopyButtonText("Copy Payment Request"), 2000);
    }
  };


  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        {/* BTC/USD Price Banner */}
        {currentPrice !== null ? (
          <div className={`mb-4 p-2 rounded text-center ${getColorClass()}`}>
            <p>BTC/USD: ${currentPrice.toLocaleString()}</p>
          </div>
        ) : (
          <div className="mb-4 p-2 rounded text-center text-gray-400">
            <p>Loading BTC price...</p>
          </div>
        )}

        <h1 className="text-2xl font-bold mb-4 text-center">Saldos de Cuenta</h1>
        <form onSubmit={handleSubmit} className="flex items-center space-x-2 mb-4">
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="Enter ID"
            className="w-full p-2 bg-gray-600 rounded text-white border border-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-green-600 rounded text-white hover:bg-green-700 disabled:bg-gray-500 transition-colors"
          >
            {loading ? "Cargando..." : "Obtener Datos"}
          </button>
        </form>

        {error && <p className="text-red-500 mb-4 text-center">{error}</p>}

        {data.length > 0 ? (
          <div>
            {data.map((item, index) => (
              <div key={index} className="bg-gray-700 p-4 rounded shadow mb-4">
                <h2 className="text-xl font-bold mb-2 text-center">
                  {item.name} {item.lastname}
                </h2>
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">BTC Balance:</span>
                  <span className="text-green-400">{item.BTCbalance} BTC</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">Saldo (Pesos):</span>
                  <span className="text-green-400">{item.COPbalance} COP</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">Rendimiento:</span>
                  <span className="text-green-400">{item.Rendimiento}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">Precio Promedio Compra:</span>
                  <span className="text-green-400">{item.AvgCompra}</span>
                </div>
              </div>
            ))}
            <button
              onClick={handleMovementsClick}
              disabled={loading}
              className="w-full mt-4 px-4 py-2 bg-blue-600 rounded text-white hover:bg-blue-700 disabled:bg-gray-500 transition-colors"
            >
              {loading ? "Cargando..." : "Mostrar Movimientos"}
            </button>
          </div>
        ) : (
          !loading && (
            <p className="text-gray-400 text-center">
              No balances found. Enter an ID to fetch.
            </p>
          )
        )}

        {movements.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-center mb-4">
              <h2 className="text-xl font-bold">Movimientos</h2>
              <button
                onClick={handleSortByDate}
                className="ml-2 text-gray-400 hover:text-white focus:outline-none"
                title={`Ordenar por fecha (${sortOrder === 'asc' ? 'ascendente' : 'descendente'})`}
              >
                <ArrowsUpDownIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              {movements.map((item, index) => (
                <div key={index} className="bg-gray-700 p-4 rounded shadow">
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-300">Fecha:</span>
                    <span>{item.Fecha}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-300">Saldo COP:</span>
                    <span className="text-gray-300">{item['Saldo COP']}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-300">Precio BTC:</span>
                    <span className="text-gray-300">{item['Precio BTC']}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-300">Precio Dolar:</span>
                    <span className="text-gray-300">{item['Precio Dolar']}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-300">Total BTC:</span>
                    <span className="text-gray-300">{item.Total}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-300">Operación:</span>
                    <span
                      className={
                        item.Operacion === 'Compra'
                          ? 'text-green-400'
                          : item.Operacion === 'Venta'
                          ? 'text-red-400'
                          : 'text-gray-300'
                      }
                    >
                      {item.Operacion}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && (
          <div className="flex justify-center mt-4">
            <div className="w-8 h-8 border-4 border-t-blue-500 border-gray-300 rounded-full animate-spin"></div>
          </div>
        )}

        <div className="mt-6">
          <h2 className="text-xl font-bold mb-4 text-center">Donations</h2>
          <input
            type="number"
            value={donationAmount}
            onChange={(e) => setDonationAmount(parseInt(e.target.value) || 0)}
            placeholder="Amount (sat)"
            className="w-full p-2 bg-gray-600 rounded text-white mb-2"
          />
          <button
            onClick={generateDonationInvoice}
            disabled={donationAmount <= 0 || paymentStatus === 'pending'}
            className="w-full px-4 py-2 bg-blue-600 rounded mb-4 disabled:bg-gray-500"
            title={donationAmount <= 0 ? 'Enter an amount greater than 0' : paymentStatus === 'pending' ? 'Waiting for payment' : ''}
          >
            Generate Donation Invoice
          </button>
          {bolt11 && (
          <div className="text-center">
            <QRCodeCanvas value={bolt11} size={128} className="mx-auto" />
            <p className="mt-2">Scan to donate {donationAmount} sats</p>
            <p className="mt-4 text-sm text-gray-300 break-all px-4">
              Payment Request: {bolt11}
            </p>
            <button
              onClick={handleCopyPaymentRequest}
              className="mt-2 px-4 py-2 bg-gray-600 rounded text-white hover:bg-gray-700 transition-colors"
            >
              {copyButtonText}
            </button>
          </div>
          )}
          {paymentStatus === 'pending' && <p className="text-yellow-400 mt-2">Payment pending...</p>}
          {paymentStatus === 'settled' && <p className="text-green-400 mt-2">Payment received! Thank you.</p>}
          {paymentStatus === 'settled' && (
            <button
              onClick={resetDonation}
              className="w-full mt-2 px-4 py-2 bg-gray-600 rounded text-white hover:bg-gray-700"
            >
              Create New Donation
            </button>
          )}
          {donationError && <p className="text-red-400 mt-2">{donationError}</p>}
        </div>

        <button
          onClick={handleWhatsAppClick}
          className="w-full mt-6 px-4 py-2 bg-green-600 rounded text-white hover:bg-green-700 transition-colors"
        >
          Contacto
        </button>
      
      </div>
    </div>
  );
}