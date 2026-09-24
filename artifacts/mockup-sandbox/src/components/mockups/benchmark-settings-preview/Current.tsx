import { Settings2 } from 'lucide-react';
import './_group.css';

export function Current() {
  const draft = { companyName: '', accentColor: '#D86B50' };
  const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'BQ';
  return <div className="benchmark-preview-frame"><aside className="card preview-card slide-up"><div className="preview-top"><div><div className="eyebrow">Live styling</div><h2 style={{ marginTop: 7, marginBottom: 0 }}>Your widget, at a glance</h2></div><Settings2 size={18} className="muted" /></div>
    <div className="mini-widget" style={{ '--preview-accent': draft.accentColor } as React.CSSProperties}><div className="mini-widget-brand"><span className="mini-mark" style={{ backgroundColor: draft.accentColor }}>{initials(draft.companyName)}</span>{draft.companyName || 'Your company'}</div><h3>See what your room could become.</h3><p>Start with a photo. We’ll help make the next conversation clearer.</p><div className="mock-input" /><div className="mock-cta" /></div>
  </aside></div>;
}