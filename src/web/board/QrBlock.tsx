// Client-side QR rendering for the board. Encodes a URL to a data URL via the
// `qrcode` lib (no network, no canvas left in the DOM) and shows it as an
// <img> with a short caption. Tuned dark: transparent-friendly light modules
// on a dark card so it scans off a projector.

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrBlock({
  value,
  label,
  size = 92,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size * 3,
      color: { dark: "#0a0d12ff", light: "#ffffffff" },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setDataUrl(null); });
    return () => { cancelled = true; };
  }, [value, size]);

  return (
    <div className="board-qr">
      {dataUrl ? (
        <img src={dataUrl} alt={label} width={size} height={size} style={{ width: size, height: size }} />
      ) : (
        <div style={{ width: size, height: size }} />
      )}
      <span className="board-qr-label">{label}</span>
    </div>
  );
}
