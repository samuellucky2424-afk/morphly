import { useState, useEffect } from 'react';
import { X, Tv, FilePlus2, MousePointerSquareDashed, Scaling, PlayCircle, AppWindow, Video, CheckCircle2, Lightbulb, Zap, AlertTriangle, MonitorPlay } from 'lucide-react';

interface StreamGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StreamGuideModal({ isOpen, onClose }: StreamGuideModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('hide_obs_guide');
    if (saved === 'true') {
      setDontShowAgain(true);
    }
  }, [isOpen]);

  const handleDontShowChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setDontShowAgain(checked);
    if (checked) {
      localStorage.setItem('hide_obs_guide', 'true');
    } else {
      localStorage.removeItem('hide_obs_guide');
    }
  };

  if (!isOpen) return null;

  const steps = [
    { num: 1, title: 'Open OBS Studio', desc: 'Launch OBS on your computer', icon: <MonitorPlay className="w-4 h-4 text-blue-400" /> },
    { num: 2, title: 'Add Window Capture', desc: 'Add Source → Window Capture', icon: <FilePlus2 className="w-4 h-4 text-emerald-400" /> },
    { num: 3, title: 'Select Morphly', desc: 'Choose the Morphly app window', icon: <MousePointerSquareDashed className="w-4 h-4 text-purple-400" /> },
    { num: 4, title: 'Fit to Screen', desc: 'Right-click → Transform → Fit to Screen', icon: <Scaling className="w-4 h-4 text-orange-400" /> },
    { num: 5, title: 'Start Virtual Camera', desc: 'Click "Start Virtual Camera" in OBS', icon: <PlayCircle className="w-4 h-4 text-pink-400" /> },
    { num: 6, title: 'Open Meeting App', desc: 'Open Zoom, WhatsApp, or Meet', icon: <AppWindow className="w-4 h-4 text-indigo-400" /> },
    { num: 7, title: 'Select OBS Camera', desc: 'Choose "OBS Virtual Camera" as your video source', icon: <Video className="w-4 h-4 text-cyan-400" /> },
    { num: 8, title: 'Start Streaming', desc: 'Click Start in Morphly to begin', icon: <CheckCircle2 className="w-4 h-4 text-green-500" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-[#0F0F12] border border-[#27272A] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[#27272A] flex-shrink-0">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Tv className="w-5 h-5 text-blue-500" />
              How to Stream Morphly
            </h2>
            <p className="text-sm text-[#A1A1AA] mt-1">
              Connect to WhatsApp, Zoom & YouTube using OBS Studio
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 text-[#A1A1AA] hover:text-white bg-[#18181B] hover:bg-[#27272A] rounded-full transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-8 custom-scrollbar">
          
          {/* Steps Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {steps.map((step) => (
              <div key={step.num} className="bg-[#18181B] border border-[#27272A] p-4 rounded-xl flex gap-4 items-start">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#27272A] flex items-center justify-center text-xs font-bold text-white shadow-inner">
                  {step.num}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-1.5 mb-1">
                    {step.title}
                    {step.icon && <span className="opacity-80">{step.icon}</span>}
                  </h3>
                  <p className="text-xs text-[#A1A1AA]">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Pro Tip */}
          <div className="bg-[#1C2033] border border-[#28315C] p-4 rounded-xl flex gap-3 items-start">
            <Lightbulb className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="text-sm font-semibold text-blue-100">Pro Tip</h4>
              <p className="text-xs text-blue-200/80 mt-1 leading-relaxed">
                Use <strong className="text-blue-300">OBS Mode</strong> in Morphly (next to Stop button) to hide the interface for a clean streaming output without UI elements showing in your video feed.
              </p>
            </div>
          </div>

          {/* Policy Section */}
          <div className="space-y-3">
            <div className="bg-[#2A1D11] border border-[#4D2E12] p-4 rounded-xl flex gap-3 items-start">
              <Zap className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-amber-200">Billing Notice</h4>
                <ul className="text-xs text-amber-200/70 mt-1.5 space-y-1 list-disc list-inside">
                  <li>Streaming consumes credits in real-time</li>
                  <li>Charges are calculated per second during active sessions</li>
                  <li>Ensure you have enough credits before starting</li>
                </ul>
              </div>
            </div>

            <div className="bg-[#2A1515] border border-[#522121] p-4 rounded-xl flex gap-3 items-start">
              <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-red-200">Important Policy</h4>
                <ul className="text-xs text-red-200/70 mt-1.5 space-y-1 list-disc list-inside">
                  <li>All payments are final and non-refundable</li>
                  <li>Credits purchased cannot be reversed once used</li>
                  <li>By using Morphly, you agree to this policy</li>
                </ul>
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#27272A] bg-[#18181B] rounded-b-2xl flex flex-col sm:flex-row items-center justify-between gap-4 flex-shrink-0">
          <label className="flex items-center gap-2 cursor-pointer group">
            <input 
              type="checkbox" 
              checked={dontShowAgain}
              onChange={handleDontShowChange}
              className="w-4 h-4 rounded border-[#3F3F46] bg-[#27272A] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 transition-all cursor-pointer"
            />
            <span className="text-sm text-[#A1A1AA] group-hover:text-white transition-colors">Don't show again</span>
          </label>
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button 
              onClick={onClose}
              className="w-full sm:w-auto px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-all shadow-lg hover:shadow-blue-500/20"
            >
              I Understand
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
