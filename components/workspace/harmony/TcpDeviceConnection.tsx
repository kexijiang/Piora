"use client";

import { useState } from "react";

export function TcpDeviceConnection({ chinese, onRefresh }: { chinese: boolean; onRefresh: () => Promise<void> }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const change = async (action: "connect" | "disconnect") => {
    if (busy) return;
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/harmony/devices/tcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: address.trim(), action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error ?? copy("HDC 操作失败", "HDC operation failed"));
      setMessage(action === "connect" ? copy("已在 HDC 设备列表核对连接。", "Connection verified in the HDC device list.")
        : copy("已在 HDC 设备列表核对断开。", "Disconnection verified in the HDC device list."));
      await onRefresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <div>
    <label>{copy("无线调试地址", "Wireless debugging address")}
      <input value={address} onChange={event => setAddress(event.target.value)} placeholder="192.168.1.10:8710" inputMode="url" />
    </label>
    <button type="button" disabled={busy || !address.trim()} onClick={() => void change("connect")}>{copy("连接 Wi-Fi 设备", "Connect Wi-Fi device")}</button>
    <button type="button" disabled={busy || !address.trim()} onClick={() => void change("disconnect")}>{copy("断开此 TCP 连接", "Disconnect this TCP device")}</button>
    <p>{copy("先在设备设置中启用无线调试并确认地址与端口；仅接受局域网 IPv4。切换通道可能中断已有会话，正在控制的设备须先释放控制权。", "Enable wireless debugging on the device and enter its address and port. Only private IPv4 is accepted. Changing transport may interrupt sessions; release device control first.")}</p>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
