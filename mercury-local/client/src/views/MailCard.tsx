import { useEffect, useState } from 'react';
import { AlertTriangle, Mail, MailCheck, Info } from 'lucide-react';
import { getMailStatus, type MailStatus } from '../lib/api';

// SMTP mail status card. Shows whether SMTP sending is configured (the App Password is present in
// the local .mercury-smtp.json config) and the send identity. There is NO OAuth "connect" button:
// the owner pastes a Google App Password into the config file and restarts — see runbook §2.
export default function MailCard() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [configFile, setConfigFile] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      const { status, configFile } = await getMailStatus();
      setStatus(status);
      setConfigFile(configFile);
    } catch {
      setError('โหลดสถานะการส่งอีเมลไม่สำเร็จ');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const configured = status?.configured ?? false;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
      <div className="flex items-center gap-2">
        {configured ? (
          <MailCheck size={18} className="text-emerald-600" />
        ) : (
          <Mail size={18} className="text-slate-400" />
        )}
        <div>
          <div className="font-semibold text-sm text-slate-700">
            {configured ? 'ตั้งค่า SMTP แล้ว (พร้อมส่ง)' : 'ยังไม่ได้ตั้งค่า SMTP'}
          </div>
          <div className="text-xs text-slate-500">
            {configured
              ? `ส่งจาก ${status?.senderName} <${status?.senderEmail}> · ผ่าน ${status?.host}:${status?.port}${
                  status?.smtpUser ? ` (บัญชี ${status.smtpUser})` : ''
                }`
              : `จะส่งจาก ${status?.senderEmail ?? 'purchasing@prominentdental.com'} (ยืนยันผ่าน ${status?.authAccountHint ?? 'khunnakritr@prominentdental.com'})`}
          </div>
        </div>
      </div>

      {status && !configured && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            ยังไม่ได้ใส่ App Password — คัดลอก{' '}
            <span className="font-mono">.mercury-smtp.example.json</span> เป็น{' '}
            <span className="font-mono">.mercury-smtp.json</span> แล้ววาง App Password (16 ตัว) ของ
            Google ลงในช่อง <span className="font-mono">SMTP_PASS</span> จากนั้นรีสตาร์ตแอป (ดูขั้นตอนใน
            runbook §2)
            {configFile ? (
              <>
                {' '}
                — ไฟล์: <span className="font-mono break-all">{configFile}</span>
              </>
            ) : null}
          </span>
        </div>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-1 text-rose-600 text-xs">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
    </div>
  );
}
