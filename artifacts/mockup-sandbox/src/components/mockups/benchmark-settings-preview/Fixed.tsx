import { ArrowRight, CloudUpload, Settings2 } from 'lucide-react';
import './_group.css';

export function Fixed() {
  const draft = { companyName: 'Benchmark Contracting Group', accentColor: '#D86B50' };
  const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'BQ';
  return <div className="benchmark-preview-frame"><aside className="card preview-card"><div className="preview-top"><div><div className="eyebrow">Live styling</div><h2 style={{ marginTop: 7, marginBottom: 0 }}>Your widget, at a glance</h2></div><Settings2 size={18} className="muted" /></div>
    <div className="mini-widget mini-widget-preview" style={{ '--preview-accent': draft.accentColor } as React.CSSProperties}>
      <div className="mini-widget-brand"><span className="mini-mark" style={{ backgroundColor: draft.accentColor }}>{initials(draft.companyName)}</span><span className="mini-widget-company">{draft.companyName || 'Your company'}</span></div>
      <div className="mini-preview-content"><div className="eyebrow">A visual starting point</div><h3>What room are you planning?</h3><p>Choose a room, add your photo, and see a design direction before requesting a quote.</p>
        <div className="mini-preview-rooms"><span>Kitchen</span><span>Bathroom</span><span>Living room</span></div>
        <div className="mini-preview-upload"><CloudUpload size={16} aria-hidden="true" /><span>Add your room photo</span></div>
        <div className="mini-preview-cta">Continue <ArrowRight size={14} aria-hidden="true" /></div>
      </div>
    </div>
    <p className="mini-preview-caption">Appearance preview only · The live widget is available from Widget embed.</p>
  </aside></div>;
}