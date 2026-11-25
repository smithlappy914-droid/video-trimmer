import React, { useState, useEffect } from "react";

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};

const toB64Url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64Url = (str) => {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  return Uint8Array.from(atob((str + pad).replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );
};

const extractYtId = (url) => {
  const m = url.match(/^.*(youtu.be\/|v\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/);
  return m && m[2].length === 11 ? m[2] : null;
};

export default function VideoTrimmer() {
  const [token, setToken] = useState(() => localStorage.getItem("clipai_token") || "");
  const [account, setAccount] = useState({ loggedIn: false, isOwner: false, credits: 0, isUnlimited: false });
  const [isIndia, setIsIndia] = useState(() =>
    (Intl.DateTimeFormat().resolvedOptions().timeZone || "").includes("Kolkata") ||
    (Intl.DateTimeFormat().resolvedOptions().timeZone || "").includes("Calcutta")
  );
  const [payMethods, setPayMethods] = useState({ upiId: "", qrDataUrl: "", cryptoAddress: "", cryptoNetwork: "USDT (TRC20)" });

  // Views: "home" | "owner_page"
  const [view, setView] = useState("home");

  // Online URL-Only Clipper State
  const [urlInput, setUrlInput] = useState("");
  const [ytId, setYtId] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [cuttingId, setCuttingId] = useState(null);
  const [readyDownloads, setReadyDownloads] = useState([]);

  // Pricing Modal State
  const [showPricing, setShowPricing] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState("pack_500");
  const [txRefInput, setTxRefInput] = useState("");
  const [payStatus, setPayStatus] = useState("");

  // First-time Owner PIN Setup (Hidden 5 clicks on footer version)
  const [footerClicks, setFooterClicks] = useState(0);
  const [showOwnerSetup, setShowOwnerSetup] = useState(false);
  const [ownerPin, setOwnerPin] = useState("");

  // Owner Admin Page State
  const [adminData, setAdminData] = useState(null);
  const [editUpi, setEditUpi] = useState("");
  const [editQr, setEditQr] = useState("");
  const [editCrypto, setEditCrypto] = useState("");
  const [editNetwork, setEditNetwork] = useState("USDT (TRC20)");
  const [adminSavedMsg, setAdminSavedMsg] = useState("");

  const loadSession = async (tk = token) => {
    try {
      const res = await fetch("/api/me", {
        headers: tk ? { "x-auth-token": tk } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      setAccount(data.account);
      if (data.detectedCountry === "IN") setIsIndia(true);
      else if (data.detectedCountry) setIsIndia(false);
      if (data.paymentMethods) setPayMethods(data.paymentMethods);
    } catch {
      // Ignore offline hiccup
    }
  };

  useEffect(() => {
    loadSession();
  }, []);

  const loadOwnerDashboard = async (tk = token) => {
    const res = await fetch("/api/owner/dashboard", {
      headers: { "x-auth-token": tk },
    });
    if (res.ok) {
      const d = await res.json();
      setAdminData(d);
      setEditUpi(d.paymentMethods.upiId || "");
      setEditQr(d.paymentMethods.qrDataUrl || "");
      setEditCrypto(d.paymentMethods.cryptoAddress || "");
      setEditNetwork(d.paymentMethods.cryptoNetwork || "USDT (TRC20)");
    }
  };

  // Biometric Login (Fingerprint / Face / Eye via WebAuthn Hardware Key)
  const handleBiometricLogin = async (setupPin = null) => {
    if (!window.PublicKeyCredential) {
      alert("Please use Chrome/Safari on a phone or laptop with Fingerprint/Face/Eye lock.");
      return;
    }
    try {
      const chRes = await fetch("/api/auth/challenge");
      const { challenge } = await chRes.json();
      const challengeBuf = fromB64Url(challenge);
      const savedCredId = localStorage.getItem("clipai_cred_id");

      let credId = "";
      if (savedCredId && !setupPin) {
        try {
          const assertion = await navigator.credentials.get({
            publicKey: {
              challenge: challengeBuf,
              allowCredentials: [{ id: fromB64Url(savedCredId), type: "public-key" }],
              userVerification: "required",
              timeout: 60000,
            },
          });
          credId = toB64Url(assertion.rawId);
        } catch {
          // Fallback to new credential registration if device reset
        }
      }

      if (!credId) {
        const created = await navigator.credentials.create({
          publicKey: {
            challenge: challengeBuf,
            rp: { name: "ClipAI Studio" },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: setupPin ? "owner@clipai" : `user_${Date.now()}@clipai`,
              displayName: setupPin ? "Site Owner" : "ClipAI Creator",
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: {
              authenticatorAttachment: "platform",
              userVerification: "required",
            },
            timeout: 60000,
          },
        });
        credId = toB64Url(created.rawId);
        localStorage.setItem("clipai_cred_id", credId);
      }

      const authRes = await fetch("/api/auth/biometric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentialId: credId,
          challenge,
          ...(setupPin ? { ownerPin: setupPin } : {}),
        }),
      });
      const authData = await authRes.json();
      if (!authRes.ok) throw new Error(authData.detail || "Biometric verification failed.");

      localStorage.setItem("clipai_token", authData.token);
      setToken(authData.token);
      setAccount(authData.account);
      setShowOwnerSetup(false);
      setOwnerPin("");

      // Automatically open dedicated Owner Payment & Control Page when Owner biometric matches
      if (authData.account.isOwner) {
        await loadOwnerDashboard(authData.token);
        setView("owner_page");
      } else {
        alert("Biometric Verified! 50 Free AI Clips unlocked.");
      }
    } catch (err) {
      alert(err.message || "Biometric scan cancelled.");
    }
  };

  // Step 1: Analyze YouTube URL for AI Highlights
  const handleAnalyze = async (e) => {
    e.preventDefault();
    const id = extractYtId(urlInput.trim());
    if (!id) {
      alert("Please paste a valid YouTube link.");
      return;
    }
    setYtId(id);
    setAnalyzing(true);
    setReadyDownloads([]);
    try {
      const res = await fetch("/api/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not scan video.");
      setVideoInfo(data);
    } catch (err) {
      alert(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // Step 2: Cut Selected AI Highlight (9:16 Reel/Short)
  const handleCutHighlight = async (hl, aspectRatio = "9:16") => {
    if (!account.loggedIn) {
      alert("Tap 'Fingerprint / Face Login' at the top to unlock 50 Free Clips!");
      return;
    }
    if (!account.isOwner && !account.isUnlimited && account.credits <= 0) {
      setShowPricing(true);
      return;
    }
    setCuttingId(hl.id);
    try {
      const res = await fetch("/api/cut-highlight", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-token": token,
        },
        body: JSON.stringify({
          url: urlInput.trim(),
          startSec: hl.startSec,
          durationSec: hl.durationSec,
          aspectRatio,
          caption: videoInfo?.title?.slice(0, 32) || "",
        }),
      });
      const data = await res.json();
      if (res.status === 402) {
        setShowPricing(true);
        return;
      }
      if (!res.ok) throw new Error(data.detail || "Clip generation failed.");

      setAccount(data.account);
      setReadyDownloads((prev) => [
        {
          id: `${hl.id}_${Date.now()}`,
          label: `${aspectRatio} Reel (${fmtTime(hl.startSec)})`,
          fileName: data.fileName,
          downloadUrl: data.downloadUrl,
        },
        ...prev,
      ]);
    } catch (err) {
      alert(err.message);
    } finally {
      setCuttingId(null);
    }
  };

  // Owner Admin: Upload QR image as Base64
  const handleQrFilePick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 350000) {
      alert("Please pick a QR image smaller than 350KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setEditQr(reader.result);
    reader.readAsDataURL(file);
  };

  const handleSavePaymentConfig = async (e) => {
    e.preventDefault();
    setAdminSavedMsg("Saving...");
    const res = await fetch("/api/owner/payment-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": token },
      body: JSON.stringify({
        upiId: editUpi,
        qrDataUrl: editQr,
        cryptoAddress: editCrypto,
        cryptoNetwork: editNetwork,
      }),
    });
    if (res.ok) {
      setAdminSavedMsg("Saved live! All users will see your updated QR/UPI/Crypto instantly.");
      loadSession();
    } else {
      setAdminSavedMsg("Save failed.");
    }
  };

  const handleApprovePayment = async (pid) => {
    const res = await fetch(`/api/owner/approve/${pid}`, {
      method: "POST",
      headers: { "x-auth-token": token },
    });
    if (res.ok) loadOwnerDashboard();
  };

  const handleSubmitUserPayment = async (e) => {
    e.preventDefault();
    const res = await fetch("/api/payments/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": token },
      body: JSON.stringify({
        region: isIndia ? "IN" : "GLOBAL",
        planId: selectedPlan,
        txRef: txRefInput,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setPayStatus("Payment submitted! Clips will be added as soon as verified.");
      setTxRefInput("");
    } else {
      setPayStatus(data.detail || "Submission failed.");
    }
  };

  // ==================== DEDICATED OWNER ADMIN PAGE ====================
  if (view === "owner_page" && account.isOwner) {
    return (
      <div className="min-h-screen bg-[#060911] text-white p-5">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div>
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                Biometric Verified • Lifetime Unlimited Active
              </span>
              <h1 className="text-2xl font-bold mt-1">Owner Payment & Control Page</h1>
            </div>
            <button
              type="button"
              onClick={() => setView("home")}
              className="bg-emerald-500 text-slate-950 font-bold text-sm px-5 py-2.5 rounded-xl"
            >
              Open Unlimited Clipper →
            </button>
          </div>

          {/* Permanent Render Env Backup Box */}
          {adminData?.ownerCredentialId && (
            <div className="bg-amber-950/30 border border-amber-500/40 rounded-2xl p-4 text-xs">
              <p className="font-bold text-amber-300 mb-1">
                Save this once in Render Environment Variables as OWNER_CREDENTIAL_ID:
              </p>
              <code className="block bg-black/60 p-2 rounded-lg text-amber-200 break-all">
                {adminData.ownerCredentialId}
              </code>
            </div>
          )}

          {/* Live Payment Settings Form (No Code Changes Ever Needed) */}
          <form
            onSubmit={handleSavePaymentConfig}
            className="bg-white/[0.04] border border-white/10 rounded-2xl p-5 space-y-4"
          >
            <h2 className="text-lg font-bold">Update Live Payment Methods (QR / UPI / Crypto)</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">India UPI ID</label>
                <input
                  type="text"
                  placeholder="yourname@upi"
                  value={editUpi}
                  onChange={(e) => setEditUpi(e.target.value)}
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3.5 py-2.5 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Upload Payment QR Image</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleQrFilePick}
                  className="w-full text-xs text-slate-300 file:bg-indigo-600 file:text-white file:border-0 file:px-3 file:py-2 file:rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Global Crypto Wallet Address</label>
                <input
                  type="text"
                  placeholder="T... or 0x..."
                  value={editCrypto}
                  onChange={(e) => setEditCrypto(e.target.value)}
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3.5 py-2.5 text-sm font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Crypto Network</label>
                <input
                  type="text"
                  value={editNetwork}
                  onChange={(e) => setEditNetwork(e.target.value)}
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3.5 py-2.5 text-sm"
                />
              </div>
            </div>

            {editQr && (
              <img src={editQr} alt="QR Preview" className="w-32 h-32 rounded-xl border border-white/20 bg-white p-1" />
            )}

            <button
              type="submit"
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm px-6 py-2.5 rounded-xl"
            >
              Save Payment Details Live
            </button>
            {adminSavedMsg && <p className="text-xs text-emerald-400">{adminSavedMsg}</p>}
          </form>

          {/* Pending User Payments Approval Table */}
          <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-5">
            <h2 className="text-lg font-bold mb-3">
              User Payments ({adminData?.totalUsers || 0} Total Users)
            </h2>
            {!adminData?.payments?.length ? (
              <p className="text-xs text-slate-400">No payment requests yet.</p>
            ) : (
              <div className="space-y-2.5">
                {adminData.payments.map((p) => (
                  <div
                    key={p.id}
                    className="bg-black/50 border border-white/10 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <span className="font-bold text-white">{p.amountLabel}</span> •{" "}
                      <span className="text-slate-400">Region: {p.region}</span>
                      <p className="font-mono text-cyan-300 mt-0.5">Ref: {p.txRef}</p>
                    </div>
                    {p.status === "APPROVED" ? (
                      <span className="text-emerald-400 font-bold">✓ Approved</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleApprovePayment(p.id)}
                        className="bg-emerald-500 text-slate-950 font-bold px-3.5 py-1.5 rounded-lg"
                      >
                        Approve & Credit
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==================== MAIN SUPER-SIMPLE ONLINE AI CLIPPER ====================
  return (
    <div className="min-h-screen bg-[#060911] text-white flex flex-col">
      {/* Clean Simple Header */}
      <header className="border-b border-white/10 bg-[#060911]/90 sticky top-0 z-20 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-400 to-indigo-600 flex items-center justify-center font-black text-slate-950">
              AI
            </div>
            <span className="font-bold text-lg">ClipAI Reels</span>
          </div>

          <div className="flex items-center gap-2.5">
            {account.loggedIn ? (
              <>
                {account.isOwner ? (
                  <button
                    type="button"
                    onClick={() => {
                      loadOwnerDashboard();
                      setView("owner_page");
                    }}
                    className="bg-amber-400 text-slate-950 font-bold text-xs px-3.5 py-2 rounded-full"
                  >
                    Owner Admin • Unlimited
                  </button>
                ) : (
                  <>
                    <span className="text-xs bg-white/10 px-3 py-1.5 rounded-full">
                      Clips Left:{" "}
                      <strong className="text-cyan-400">
                        {account.isUnlimited ? "Unlimited" : account.credits}
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPricing(true)}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-4 py-2 rounded-full"
                    >
                      {isIndia ? "Buy ₹130" : "Upgrade $5"}
                    </button>
                  </>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => handleBiometricLogin()}
                className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-slate-950 font-extrabold text-xs px-4 py-2.5 rounded-full shadow-lg"
              >
                Fingerprint / Eye Login (50 Free)
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Simple 2-Step Main Body (Strictly URL Only on Web) */}
      <main className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 space-y-6">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight">
            Paste Link. Get Viral Reels.
          </h1>
          <p className="text-sm text-slate-400 mt-2">
            AI finds the best highlights from any YouTube video and cuts ready-to-post 9:16 Shorts & Reels.
          </p>
        </div>

        {/* Step 1: URL Input ONLY */}
        <form
          onSubmit={handleAnalyze}
          className="bg-white/[0.04] border border-white/10 rounded-2xl p-3 flex flex-col sm:flex-row gap-3 max-w-3xl mx-auto"
        >
          <input
            type="url"
            required
            placeholder="Paste YouTube video URL here..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 bg-black/60 border border-white/15 rounded-xl px-4 py-3.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
          <button
            type="submit"
            disabled={analyzing}
            className="bg-white text-slate-950 hover:bg-cyan-300 font-extrabold text-sm px-7 py-3.5 rounded-xl transition shrink-0 disabled:opacity-50"
          >
            {analyzing ? "AI Scanning..." : "Find AI Highlights"}
          </button>
        </form>

        {/* Step 2: Preview + AI Highlight Cards */}
        {videoInfo && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-2">
            <div className="lg:col-span-5 space-y-3">
              {ytId && (
                <iframe
                  src={`https://www.youtube.com/embed/${ytId}`}
                  title="Preview"
                  className="w-full aspect-video rounded-2xl border border-white/10 bg-black"
                  allowFullScreen
                />
              )}
              <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-4">
                <p className="font-bold text-sm line-clamp-2">{videoInfo.title}</p>
                <p className="text-xs text-slate-400 mt-1">
                  Video Length: {fmtTime(videoInfo.duration)}
                </p>
              </div>
            </div>

            <div className="lg:col-span-7 space-y-3">
              <h2 className="text-base font-bold text-cyan-300">
                AI Found {videoInfo.highlights.length} Best Highlight Moments:
              </h2>
              {videoInfo.highlights.map((hl, idx) => (
                <div
                  key={hl.id}
                  className="bg-white/[0.04] border border-white/10 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="bg-emerald-500/20 text-emerald-300 text-xs font-bold px-2.5 py-0.5 rounded-full">
                        Viral Score {hl.viralScore}%
                      </span>
                      <span className="text-xs font-mono text-slate-300">
                        {fmtTime(hl.startSec)} → {fmtTime(hl.startSec + hl.durationSec)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Highlight #{idx + 1} • {hl.reason}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={cuttingId !== null}
                      onClick={() => handleCutHighlight(hl, "9:16")}
                      className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-slate-950 font-extrabold text-xs px-4 py-2.5 rounded-xl disabled:opacity-40"
                    >
                      {cuttingId === hl.id ? "Cutting..." : "Make 9:16 Reel"}
                    </button>
                    <button
                      type="button"
                      disabled={cuttingId !== null}
                      onClick={() => handleCutHighlight(hl, "16:9")}
                      className="bg-white/10 hover:bg-white/20 text-white font-bold text-xs px-3 py-2.5 rounded-xl disabled:opacity-40"
                    >
                      16:9
                    </button>
                  </div>
                </div>
              ))}

              {/* Ready Downloads */}
              {readyDownloads.length > 0 && (
                <div className="pt-4 border-t border-white/10 space-y-2.5">
                  <h3 className="text-sm font-bold text-emerald-400">Ready to Save & Post:</h3>
                  {readyDownloads.map((item) => (
                    <div
                      key={item.id}
                      className="bg-emerald-950/30 border border-emerald-500/40 rounded-xl p-3 flex items-center justify-between"
                    >
                      <span className="text-xs font-bold">{item.label}</span>
                      <a
                        href={item.downloadUrl}
                        download={item.fileName}
                        className="bg-emerald-500 text-slate-950 font-extrabold text-xs px-4 py-2 rounded-lg"
                      >
                        Download MP4
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer with Hidden 5-Click First-Time Owner Biometric Bind */}
      <footer className="border-t border-white/5 py-4 text-center text-xs text-slate-500">
        <span>ClipAI Studio • Online AI Reels Engine • </span>
        <button
          type="button"
          onClick={() => {
            if (footerClicks + 1 >= 5) {
              setFooterClicks(0);
              setShowOwnerSetup(true);
            } else {
              setFooterClicks(footerClicks + 1);
            }
          }}
          className="text-slate-600 cursor-default select-none"
        >
          v3.0
        </button>
      </footer>

      {/* Geo-Targeted Pricing & Live Owner QR/UPI/Crypto Modal */}
      {showPricing && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur flex items-center justify-center p-4">
          <div className="bg-[#0c101a] border border-white/15 rounded-2xl max-w-lg w-full p-6 relative space-y-4">
            <button
              type="button"
              onClick={() => setShowPricing(false)}
              className="absolute top-4 right-4 text-slate-400"
            >
              ✕
            </button>
            <h2 className="text-xl font-bold">
              {isIndia ? "India Plans (INR)" : "Global Plans (USD)"}
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSelectedPlan("pack_500")}
                className={`p-4 rounded-xl border text-left ${
                  selectedPlan === "pack_500"
                    ? "border-cyan-400 bg-cyan-500/10"
                    : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <div className="text-2xl font-black">{isIndia ? "₹130" : "$5"}</div>
                <p className="text-xs text-slate-300 mt-1">500 AI Video Clips</p>
              </button>

              <button
                type="button"
                onClick={() => setSelectedPlan("unlimited")}
                className={`p-4 rounded-xl border text-left ${
                  selectedPlan === "unlimited"
                    ? "border-violet-400 bg-violet-500/10"
                    : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <div className="text-2xl font-black">$50</div>
                <p className="text-xs text-slate-300 mt-1">Unlimited AI Clips</p>
              </button>
            </div>

            {/* Dynamic Owner Payment Details (QR / UPI / Crypto) */}
            <div className="bg-black/50 border border-white/10 rounded-xl p-4 space-y-2 text-xs">
              {payMethods.qrDataUrl && (
                <img
                  src={payMethods.qrDataUrl}
                  alt="Scan QR to Pay"
                  className="w-36 h-36 mx-auto rounded-lg bg-white p-1"
                />
              )}
              {isIndia && payMethods.upiId && (
                <p>
                  UPI ID: <strong className="text-cyan-300 select-all">{payMethods.upiId}</strong>
                </p>
              )}
              {payMethods.cryptoAddress && (
                <p className="break-all">
                  Crypto ({payMethods.cryptoNetwork}):{" "}
                  <strong className="text-emerald-300 font-mono select-all">
                    {payMethods.cryptoAddress}
                  </strong>
                </p>
              )}
            </div>

            <form onSubmit={handleSubmitUserPayment} className="space-y-3">
              <input
                type="text"
                required
                placeholder="Paste UPI UTR Number or Crypto Tx Hash after paying..."
                value={txRefInput}
                onChange={(e) => setTxRefInput(e.target.value)}
                className="w-full bg-black/60 border border-white/15 rounded-xl px-3.5 py-2.5 text-xs"
              />
              <button
                type="submit"
                className="w-full bg-emerald-500 text-slate-950 font-extrabold text-sm py-3 rounded-xl"
              >
                Submit Payment & Unlock Clips
              </button>
              {payStatus && <p className="text-xs text-cyan-300">{payStatus}</p>}
            </form>
          </div>
        </div>
      )}

      {/* Hidden First-Time Owner Biometric Lock Setup Modal */}
      {showOwnerSetup && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur flex items-center justify-center p-4">
          <div className="bg-[#0c101a] border border-amber-500/40 rounded-2xl max-w-sm w-full p-6 relative space-y-4">
            <button
              type="button"
              onClick={() => setShowOwnerSetup(false)}
              className="absolute top-4 right-4 text-slate-400"
            >
              ✕
            </button>
            <h3 className="text-lg font-bold text-amber-300">One-Time Owner Biometric Lock</h3>
            <p className="text-xs text-slate-400">
              Enter your OWNER_PIN once and scan your Fingerprint / Eye. After this, normal login will automatically unlock your Unlimited Mode & Admin Payment Page.
            </p>
            <input
              type="password"
              placeholder="Enter OWNER_PIN..."
              value={ownerPin}
              onChange={(e) => setOwnerPin(e.target.value)}
              className="w-full bg-black/60 border border-white/15 rounded-xl px-3.5 py-2.5 text-sm"
            />
            <button
              type="button"
              onClick={() => handleBiometricLogin(ownerPin)}
              className="w-full bg-amber-400 text-slate-950 font-extrabold text-xs py-3 rounded-xl"
            >
              Lock My Biometrics as Owner
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
