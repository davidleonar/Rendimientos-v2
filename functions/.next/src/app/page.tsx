"use client";
import { useState, useEffect } from "react";
import '../app/globals.css';
import { ArrowsUpDownIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { QRCodeCanvas } from 'qrcode.react'; // Use named export

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

export default function Home() {
  const [id, setId] = useState<string>("");
  const [data, setData] = useState<SpreadsheetRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null); // Unified error state
  // State for BTC/USD price tracking
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  // State for sort order in movements
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  // States for donations
  const [donationAmount, setDonationAmount] = useState<number>(0);
  const [bolt11, setBolt11] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'settled' | null>(null);
  const [copied, setCopied] = useState(false); // For copy feedback

  // Fetch BTC/USD price from CoinGecko API every 30 seconds
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
        );
        if (!response.ok) throw new Error('Failed to fetch BTC price');
        const data = await response.json();
        const newPrice = data.bitcoin.usd;
        setPrevPrice(currentPrice); // Store previous price before updating
        setCurrentPrice(newPrice);
      } catch (err) {
        setError('Unable to fetch BTC price. Please try again later.');
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
      ? 'text-red-400' // Price decreased
      : 'text-white'; // No change
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    setMovements([]); // Reset movements when fetching new balance data
    try {
      const response = await fetch(
        `https://us-central1-rendimientos-5dbb9.cloudfunctions.net/getDataById?id=${id}`,
        { method: 'GET' }
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? `No data found for ID: ${id}`
            : `Failed to fetch data (Status: ${response.status})`
        );
      }
      const result = await response.json();
      setData(result.data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred while fetching data.'
      );
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
        { method: 'GET' }
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? `No movements found for ID: ${id}`
            : `Failed to fetch movements (Status: ${response.status})`
        );
      }
      const result = await response.json();
      setMovements(result.data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred while fetching movements.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleMovementsClick = () => {
    if (movements.length === 0) {
      fetchMovements();
    } else {
      setMovements([]); // Toggle off if already shown
    }
  };

  const handleSortByDate = () => {
    const newOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    setSortOrder(newOrder);
    setMovements((prev) =>
      [...prev].sort((a, b) => {
        const dateA = new Date(a.Fecha);
        const dateB = new Date(b.Fecha);
        return newOrder === 'asc'
          ? dateA.getTime() - dateB.getTime()
          : dateB.getTime() - dateA.getTime();
      })
    );
  };

  const generateDonationInvoice = async () => {
    setLoading(true);
    setError(null);
    setPaymentStatus('pending');
    try {
      const response = await fetch('/api/lndProxy/v1/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: donationAmount, // Assuming satoshis
        }),
      });

      if (!response.ok) {
        throw new Error(
          response.status === 400
            ? 'Invalid donation amount. Please enter a valid number.'
            : `Failed to generate donation invoice (Status: ${response.status})`
        );
      }

      const data = await response.json();
      setBolt11(data.payment_request);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred while generating donation invoice.'
      );
      setPaymentStatus(null);
    } finally {
      setLoading(false);
    }
  };

  const resetDonation = () => {
    setBolt11(null);
    setPaymentStatus(null);
    setDonationAmount(0);
    setError(null); // Clear error on reset
  };

  const handleCopy = async () => {
    if (bolt11) {
      try {
        await navigator.clipboard.writeText(bolt11);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000); // Reset feedback after 2s
      } catch (err) {
        setError('Failed to copy invoice to clipboard.');
        console.error('Clipboard error:', err);
      }
    }
  };

  const handleWhatsAppClick = () => {
    // Implement WhatsApp contact logic if needed
    window.open('https://wa.me/yournumber', '_blank');
  };

  return (
    <div className="min-h-screen bg-gray-800 text-white flex items-center justify-center">
      <div className="max-w-md w-full p-6 bg-gray-900 rounded shadow-md">
        <h1 className="text-2xl font-bold mb-4 text-center">Rendimientos</h1>

        {/* BTC Price Display */}
        {currentPrice && (
          <p className={`text-center mb-4 ${getColorClass()}`}>
            BTC/USD: ${currentPrice.toLocaleString()}
          </p>
        )}

        <div className="flex items-center mb-4">
          <input
            type="text"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setError(null); // Clear error on input change
            }}
            placeholder="Enter ID"
            className="flex-1 p-2 bg-gray-600 rounded text-white"
          />
          <button
            onClick={fetchData}
            disabled={loading}
            className="ml-2 px-4 py-2 bg-blue-600 rounded hover:bg-blue-700 disabled:bg-gray-500 transition-colors"
          >
            {loading ? 'Cargando...' : 'Buscar'}
          </button>
        </div>

        {error && (
          <p className="text-red-400 text-center mb-4">{error}</p>
        )}

        {data.length > 0 ? (
          <div>
            {data.map((item, index) => (
              <div key={index} className="bg-gray-700 p-4 rounded shadow mb-4">
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">Nombre:</span>
                  <span>{item.name} {item.lastname}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">Saldo BTC:</span>
                  <span className="text-yellow-400">{item.BTCbalance}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-gray-300">Saldo COP:</span>
                  <span className="text-blue-400">{item.COPbalance}</span>
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
              {loading ? 'Cargando...' : 'Mostrar Movimientos'}
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
            onChange={(e) => {
              setDonationAmount(parseInt(e.target.value) || 0);
              setError(null); // Clear error on input change
            }}
            placeholder="Amount (sat)"
            className="w-full p-2 bg-gray-600 rounded text-white mb-2"
          />
          <button
            onClick={generateDonationInvoice}
            disabled={donationAmount <= 0 || paymentStatus === 'pending' || loading}
            className="w-full px-4 py-2 bg-blue-600 rounded mb-4 disabled:bg-gray-500"
            title={
              donationAmount <= 0
                ? 'Enter an amount greater than 0'
                : paymentStatus === 'pending'
                ? 'Waiting for payment'
                : ''
            }
          >
            Generate Donation Invoice
          </button>
          {bolt11 && (
            <div className="text-center">
              <QRCodeCanvas value={bolt11} size={128} className="mx-auto" />
              <p className="mt-2">Scan to donate {donationAmount} sats</p>
              <p className="mt-2 text-sm break-all text-gray-300">{bolt11}</p>
              <button
                onClick={handleCopy}
                className="mt-2 flex items-center mx-auto bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm text-white"
              >
                <DocumentDuplicateIcon className="h-4 w-4 mr-1" />
                {copied ? 'Copied!' : 'Copy Invoice'}
              </button>
            </div>
          )}
          {paymentStatus === 'pending' && (
            <p className="text-yellow-400 mt-2">Payment pending...</p>
          )}
          {paymentStatus === 'settled' && (
            <p className="text-green-400 mt-2">Payment received! Thank you.</p>
          )}
          {paymentStatus === 'settled' && (
            <button
              onClick={resetDonation}
              className="w-full mt-2 px-4 py-2 bg-gray-600 rounded text-white hover:bg-gray-700"
            >
              Create New Donation
            </button>
          )}
          {error && donationAmount > 0 && (
            <p className="text-red-400 mt-2">{error}</p>
          )}
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