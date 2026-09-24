import { type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ArrowUpRight, Bath, BedDouble, Check, ChevronLeft, ClipboardCheck, CloudUpload, Copy, ExternalLink, FileImage, Hammer, LayoutTemplate, LoaderCircle, Mail, Paintbrush, RefreshCcw, Send, Settings2, ShieldCheck, Sparkles, Sofa, SquareCheck, X } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';

const queryClient = new QueryClient();
const KITCHEN_IMAGE = '/sample-kitchen.jpg';
const LIVING_IMAGE = '/sample-living-room.jpg';

type RoomType = 'kitchen' | 'bathroom' | 'living-room' | 'bedroom' | 'other';
type FlowStatus = 'welcome' | 'room' | 'upload' | 'processing' | 'results' | 'contact' | 'submitted';
type ContractorConfig = { id?: string; companyName: string; website: string; quoteEmail: string; accentColor: string; logoInitials: string };
type Homeowner = { name: string; email: string; phone: string; notes: string };
type DemoSession = { contractor: ContractorConfig; roomType: RoomType; originalImageUrl: string; originalImageName: string; redesignImageUrl: string; designBrief: string; designSummary: string; checklist: string[]; homeowner: Homeowner; flowStatus: FlowStatus; referenceId: string; contractorUserId?: string };
type RedesignResponse = { imageBase64: string; mimeType: 'image/png' };
type ApiErrorResponse = { error?: string };
type RedesignAllowance = { remaining: number; limit: number; resetsAt: string; exhaustedReason: string | null };
type SavedRequest = { id: string; roomType: RoomType; designBrief: string; homeownerName: string; homeownerEmail: string; homeownerPhone: string; homeownerNotes: string; originalImageUrl: string; redesignImageUrl: string; createdAt: string; expiresAt: string };
type SaveReceipt = { request: SavedRequest; deletionToken: string };
type ContractorProfile = Omit<ContractorConfig, 'logoInitials'> & { id: string };
type PublicWidgetProfile = { id: string; companyName: string; accentColor: string };
type PublicRedesign = { imageBase64: string; mimeType: string; checklist: string[]; designSummary: string; redesignToken: string };
type PublicRequestReceipt = { referenceId: string; requestId: string; deletionToken: string };

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#25634e', colorForeground: '#203138', colorMutedForeground: '#5f6c70',
    colorDanger: '#b3332e', colorBackground: '#fbf9f3', colorInput: '#ffffff',
    colorInputForeground: '#203138', colorNeutral: '#c9c5ba',
    fontFamily: 'DM Sans, sans-serif', borderRadius: '12px',
  },
  elements: {
    cardBox: { width: '440px', maxWidth: '100%', backgroundColor: '#fbf9f3' },
    card: { backgroundColor: 'transparent', boxShadow: 'none' },
    footer: { backgroundColor: 'transparent', boxShadow: 'none' },
  },
};

function AccessPanel({ allowance, loading }: { allowance: RedesignAllowance | null; loading: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  if (!isLoaded) return <p className="muted">Checking contractor access…</p>;
  if (!isSignedIn) return <div className="access-panel"><strong>Contractor access required for AI redesigns</strong><p>Sign in or create a contractor account to enable redesigns. The homeowner preview stays available without an account.</p><Link className="button button-primary" href="/sign-in">Sign in</Link> <Link className="button button-quiet" href="/sign-up">Create account</Link></div>;
  return <div className="access-panel"><strong>AI redesign allowance</strong><p>{loading ? 'Checking monthly allowance…' : allowance ? `${allowance.remaining} of ${allowance.limit} redesigns remaining this month. ${allowance.exhaustedReason ?? ''}` : 'Allowance is unavailable. Redesigns remain disabled until it can be checked.'}</p>{allowance?.exhaustedReason && <p>Allowance resets {new Date(allowance.resetsAt).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric' })}. Contact the site owner if you need more access.</p>}<p className="field-note">Each AI request reserves an estimated cost against the site-wide monthly budget, even if the provider fails. This is not a provider billing statement.</p><Link href="/requests" className="button button-quiet">Saved requests</Link> <button type="button" className="button button-ghost" onClick={() => signOut({ redirectUrl: basePath || '/' })}>Sign out</button></div>;
}

function useAllowance() {
  const { isLoaded, isSignedIn } = useAuth();
  const [allowance, setAllowance] = useState<RedesignAllowance | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      const response = await fetch('/api/redesigns/allowance');
      setAllowance(response.ok ? await response.json() as RedesignAllowance : null);
    } catch { setAllowance(null); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setAllowance(null); setLoading(false); return; }
    setLoading(true);
    void refresh();
  }, [isLoaded, isSignedIn]);
  return { allowance, loading, refresh };
}

const defaults: ContractorConfig = { companyName: 'Benchmark Contracting Group', website: 'benchmarkcontracting.com', quoteEmail: 'quotes@benchmarkcontracting.com', accentColor: '#D86B50', logoInitials: 'BC' };
const emptyHomeowner: Homeowner = { name: '', email: '', phone: '', notes: '' };
const roomLabels: Record<RoomType, string> = { kitchen: 'Kitchen', bathroom: 'Bathroom', 'living-room': 'Living room', bedroom: 'Bedroom', other: 'Other room' };
const checklistTemplates: Record<RoomType, string[]> = {
  kitchen: ['Measure existing footprint and ceiling height', 'Review cabinet layout, door swing, and storage needs', 'Confirm appliance sizes and utility locations', 'Discuss worktop, splashback, and lighting finishes'],
  bathroom: ['Confirm room dimensions and plumbing positions', 'Review fixture locations and ventilation route', 'Choose tile coverage, grout, and shower screen details', 'Allow for waterproofing, access, and finish protection'],
  'living-room': ['Measure room, openings, and built-in opportunities', 'Review lighting, power points, and media requirements', 'Discuss joinery, flooring, and paint direction', 'Plan furniture clearances and installation access'],
  bedroom: ['Measure room and wardrobe wall positions', 'Review storage, lighting, and power requirements', 'Discuss flooring, wall finish, and joinery direction', 'Confirm furniture clearances and delivery access'],
  other: ['Confirm dimensions, access, and existing conditions', 'Review surfaces, fixtures, and service locations', 'Discuss finish direction and functional priorities', 'Plan sequencing, protection, and installation access'],
};
const designSummaries: Record<RoomType, string> = {
  kitchen: 'A warm, practical kitchen direction with natural timber, tactile stone, and a considered lighting plan. The intent is to keep the room hardworking while giving it a calmer visual rhythm.',
  bathroom: 'A quiet, hotel-like bathroom direction pairing mineral surfaces with warm metal details. The layout should feel open, easy to maintain, and generous in the everyday moments.',
  'living-room': 'A relaxed living room direction built around soft texture, flexible storage, and a warmer tonal palette. The goal is a room that feels finished without feeling overly styled.',
  bedroom: 'A restorative bedroom direction using low-contrast materials, built-in storage, and soft layered light. The scheme keeps attention on comfort and a clean, useful plan.',
  other: 'A considered renovation direction focused on clearer flow, durable materials, and the details that make the room work harder. Your contractor will refine the scope on site.',
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) as T : fallback;
  } catch {
    return fallback;
  }
}

function createSession(config: ContractorConfig): DemoSession {
  return { contractor: config, roomType: 'kitchen', originalImageUrl: KITCHEN_IMAGE, originalImageName: 'benchmark-kitchen-sample.jpg', redesignImageUrl: LIVING_IMAGE, designBrief: 'Warm natural materials, practical storage, and soft layered lighting.', designSummary: designSummaries.kitchen, checklist: checklistTemplates.kitchen, homeowner: emptyHomeowner, flowStatus: 'welcome', referenceId: 'BQ-2048', };
}

function Brand({ config = defaults }: { config?: Pick<ContractorConfig, 'companyName' | 'accentColor' | 'logoInitials'> }) {
  return <div className="brand" data-testid="brand">
    <span className="brand-mark" style={{ backgroundColor: config.accentColor }}>{config.logoInitials}</span>
    <span>{config.companyName}<small>Visual quote intake</small></span>
  </div>;
}

function MarketingHeader() {
  return <header className="page-frame topbar">
    <Link href="/" className="brand" data-testid="link-home">
      <span className="brand-mark">BQ</span>
      <span>Build / quote<small>Contractor visual intake</small></span>
    </Link>
    <nav className="nav-links" aria-label="Main navigation">
      <Link href="/contractor-setup" data-testid="link-setup">Contractor settings</Link>
      <Link href="/embed-preview" data-testid="link-embed">Widget embed</Link>
      <Link href="/requests">Saved requests</Link>
    </nav>
    <Link href="/contractor-setup" className="button button-primary" data-testid="button-header-start">Start setup <ArrowUpRight size={15} /></Link>
  </header>;
}

function Home() {
  return <div className="app-shell">
    <MarketingHeader />
    <main>
      <section className="hero page-frame">
        <div className="hero-grid">
          <div className="slide-up">
            <div className="eyebrow">A clearer first conversation</div>
            <h1 className="display">Turn a room photo into a <em>better brief.</em></h1>
            <p className="hero-lead">Build / quote gives homeowners a useful design direction before they reach your inbox — so your next conversation starts with context, not guesswork.</p>
            <div className="hero-actions">
              <Link href="/contractor-setup" className="button button-primary" data-testid="button-hero-setup">Configure your intake <ArrowRight size={16} /></Link>
              <Link href="/requests" className="button button-quiet" data-testid="button-hero-homeowner">Review saved requests</Link>
            </div>
            <div className="hero-note"><ShieldCheck size={15} /> Homeowners can create a real AI design direction and request a conversation.</div>
          </div>
          <div className="hero-art fade-in" aria-label="Renovation project imagery">
            <div className="art-frame art-main"><div className="art-label">KITCHEN / NORTH FREMANTLE</div></div>
            <div className="art-frame art-inset" />
            <div className="art-tag">ROUGH SCOPE → CLEARER LEAD</div>
          </div>
        </div>
      </section>
      <div className="marquee"><span>ROOM CONTEXT</span><span>DESIGN DIRECTION</span><span>ROUGH CHECKLIST</span><span>READY-TO-REVIEW LEAD</span><span>ROOM CONTEXT</span><span>DESIGN DIRECTION</span></div>
      <section className="section-pad page-frame">
        <div className="section-heading">
          <div><div className="eyebrow">A small workflow with a big payoff</div><h2>Less back-and-forth. More useful first calls.</h2></div>
          <p>It is not trying to replace your site, your eye, or your estimate. It simply gets a homeowner to explain what they mean.</p>
        </div>
        <div className="story-grid">
          <article className="story-card"><span className="story-number">01 / SET THE SCENE</span><h3>A homeowner brings the room.</h3><p>They choose any interior room, upload a photo, and describe what they would like to change.</p><Sparkles size={65} /></article>
          <article className="story-card"><span className="story-number">02 / MAKE IT LEGIBLE</span><h3>They see a direction.</h3><p>A visual reference and rough checklist help them put shape around the project.</p><Paintbrush size={54} /></article>
          <article className="story-card"><span className="story-number">03 / PASS IT ON</span><h3>You get the useful bit.</h3><p>Contact details, context, visuals, and caveats arrive in one reviewable request.</p><Mail size={54} /></article>
        </div>
      </section>
      <section className="dark-panel section-pad">
        <div className="page-frame quote-strip">
          <blockquote>“A quote request should feel like <span>the start of a project</span>, not a blank form.”</blockquote>
          <div className="quote-meta"><div className="eyebrow">Designed for the first five minutes</div><p>Set up your contractor profile, embed the intake on your website, and receive homeowner requests in your private workspace.</p><Link href="/contractor-setup" className="button button-accent" data-testid="button-quote-setup">Set up your intake <ArrowRight size={15} /></Link></div>
        </div>
      </section>
    </main>
    <footer className="footer"><div className="page-frame" style={{ display: 'flex', justifyContent: 'space-between', gap: 15 }}><span>Build / quote</span><span>Practical by design · Estimated, not promised</span></div></footer>
  </div>;
}

function ProductHeader({ active, config }: { active: number; config: ContractorConfig }) {
  const steps = ['Settings', 'Embed', 'Homeowner', 'Requests'];
  return <header className="product-header"><div className="page-frame product-header-inner">
    <Link href="/" className="crumb" data-testid="link-product-home"><ChevronLeft size={15} /><Brand config={config} /></Link>
    <div className="workflow" aria-label="Pilot workflow">{steps.map((step, index) => <div className={`workflow-step ${index === active ? 'active' : ''} ${index < active ? 'done' : ''}`} key={step}><b>{index < active ? <Check size={12} /> : index + 1}</b><span>{step}</span></div>)}</div>
  </div></header>;
}

function initials(companyName: string) {
  return companyName.split(/\s+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'BQ';
}

function profileConfig(profile: ContractorProfile): ContractorConfig {
  return { ...profile, logoInitials: initials(profile.companyName) };
}

function apiMessage(data: unknown, fallback: string) {
  if (typeof data !== 'object' || data === null) return fallback;
  if ('error' in data && typeof data.error === 'string') return data.error;
  if ('message' in data && typeof data.message === 'string') return data.message;
  return fallback;
}

function ContractorSettings({ config }: { config: ContractorConfig }) {
  const [, setLocation] = useLocation();
  const [profile, setProfile] = useState<ContractorProfile | null>(null);
  const [draft, setDraft] = useState<ContractorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const cameFromLegacyWidget = new URLSearchParams(window.location.search).get('notice') === 'legacy-widget';
  useEffect(() => {
    let cancelled = false;
    fetch('/api/contractor-profile', { credentials: 'include' }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, response.status === 401 ? 'Sign in to manage your contractor profile.' : 'Could not load your settings.'));
      if (typeof data.id !== 'string') throw new Error('The contractor profile response is missing its profile ID.');
      return data as ContractorProfile;
    }).then((data) => { if (!cancelled) { setProfile(data); setDraft(data); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load your settings.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const update = (field: keyof Omit<ContractorProfile, 'id'>, value: string) => {
    setSaved(false);
    setDraft((current) => current ? { ...current, [field]: value } : current);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true); setError(''); setSaved(false);
    try {
      const response = await fetch('/api/contractor-profile', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: draft.companyName, website: draft.website, quoteEmail: draft.quoteEmail, accentColor: draft.accentColor }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(apiMessage(data, 'Could not save your settings. Please check the fields and try again.'));
      }
      setProfile(draft); setDraft(draft); setSaved(true);
      setLocation('/embed-preview');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save your settings.'); }
    finally { setSaving(false); }
  };
  const activeConfig = profile ? profileConfig(profile) : config;
  return <div className="app-shell"><ProductHeader active={0} config={activeConfig} /><main className="page-frame workspace">
    <div className="workspace-head"><div className="eyebrow">Contractor workspace / settings</div><h1 className="display">Make the intake feel like you.</h1><p>These settings are stored on your contractor profile and shown to homeowners using your widget.</p></div>
    {cameFromLegacyWidget && <div className="error-banner" role="status">The old Benchmark widget link did not include a tenant profile ID. No public alias is available; use the current widget URL and embed snippet shown after opening Widget embed.</div>}
    {loading ? <p className="muted" role="status">Loading contractor settings…</p> : !draft ? <div className="card form-card"><p role="alert" className="error-banner">{error}</p><Link className="button button-primary" href="/sign-in">Sign in to continue</Link></div> :
    <div className="two-col">
      <form className="card form-card slide-up" onSubmit={(event) => void save(event)}>
        <h2>Company details</h2>
        <div className="field-grid">
          <div className="field"><label htmlFor="company-name">Company name</label><input id="company-name" data-testid="input-company-name" value={draft.companyName} onChange={(event) => update('companyName', event.target.value)} required /></div>
          <div className="field"><label htmlFor="company-website">Website</label><input id="company-website" data-testid="input-company-website" value={draft.website} onChange={(event) => update('website', event.target.value)} placeholder="yourcompany.com" /></div>
        </div>
        <div className="field"><label htmlFor="quote-email">Quote inbox</label><input id="quote-email" data-testid="input-quote-email" type="email" value={draft.quoteEmail} onChange={(event) => update('quoteEmail', event.target.value)} required /><span className="field-note">New homeowner requests are sent to this address.</span></div>
        <div className="field"><label htmlFor="accent-color">Accent color</label><div className="color-row"><input id="accent-color" data-testid="input-accent-color" type="color" value={draft.accentColor} onChange={(event) => update('accentColor', event.target.value)} /><span className="mono" style={{ fontSize: 12 }}>{draft.accentColor.toUpperCase()}</span></div><span className="field-note">Used for the primary action in your homeowner widget.</span></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="form-actions"><span className="save-state" aria-live="polite">{saved ? <><Check size={14} /> Saved</> : <><ShieldCheck size={14} /> Server profile</>}</span><button className="button button-primary" data-testid="button-save-config" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} /></button></div>
      </form>
      <aside className="card preview-card slide-up" aria-label="Appearance preview of the homeowner widget"><div className="preview-top"><div><div className="eyebrow">Live styling</div><h2 style={{ marginTop: 7, marginBottom: 0 }}>Your widget, at a glance</h2></div><Settings2 size={18} className="muted" /></div>
        <div className="mini-widget mini-widget-preview" style={{ '--preview-accent': draft.accentColor } as CSSProperties}>
          <div className="mini-widget-brand"><span className="mini-mark" style={{ backgroundColor: draft.accentColor }}>{initials(draft.companyName)}</span><span className="mini-widget-company">{draft.companyName || 'Your company'}</span></div>
          <div className="mini-preview-content"><div className="eyebrow">A visual starting point</div><h3>What room are you planning?</h3><p>Choose a room, add your photo, and see a design direction before requesting a quote.</p>
            <div className="mini-preview-rooms"><span>Kitchen</span><span>Bathroom</span><span>Living room</span></div>
            <div className="mini-preview-upload"><CloudUpload size={16} aria-hidden="true" /><span>Add your room photo</span></div>
            <div className="mini-preview-cta">Continue <ArrowRight size={14} aria-hidden="true" /></div>
          </div>
        </div>
        <p className="mini-preview-caption">Appearance preview only · The live widget is available from Widget embed.</p>
      </aside>
    </div>}
  </main></div>;
}

function EmbedPreview({ config }: { config: ContractorConfig }) {
  const [profile, setProfile] = useState<ContractorProfile | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/contractor-profile', { credentials: 'include' }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, 'Could not load the contractor profile.'));
      if (typeof data.id !== 'string') throw new Error('The contractor profile response is missing its profile ID.');
      return data as ContractorProfile;
    }).then((data) => { if (!cancelled) setProfile(data); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load the contractor profile.'); });
    return () => { cancelled = true; };
  }, []);
  const widgetUrl = profile ? `${window.location.origin}${basePath}/widget/${encodeURIComponent(profile.id)}` : '';
  const snippet = widgetUrl ? `<iframe src="${widgetUrl}" title="Request a visual quote" width="100%" height="900" frameborder="0" loading="lazy"></iframe>` : '';
  const copy = async () => {
    if (!snippet) return;
    try { await navigator.clipboard.writeText(snippet); setCopied(true); window.setTimeout(() => setCopied(false), 2200); }
    catch { setError('Clipboard access was blocked. Select and copy the iframe snippet manually.'); }
  };
  return <div className="app-shell"><ProductHeader active={1} config={profile ? profileConfig(profile) : config} /><main className="page-frame workspace">
    <div className="workspace-head"><div className="eyebrow">Contractor workspace / widget embed</div><h1 className="display">Add the intake to your website.</h1><p>This stable iframe URL loads your profile directly from the server. Its fixed height keeps the form scrollable on desktop and mobile.</p></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!profile ? <p className="muted">{error ? 'Check sign-in and profile access, then reload.' : 'Loading your widget URL…'}</p> :
    <div className="two-col">
      <section className="card form-card"><div className="eyebrow">Embed snippet</div><h2 style={{ marginTop: 10 }}>Add to {profile.website || 'your website'}.</h2><div className="embed-code"><span className="code-comment">&lt;!-- Build / quote intake --&gt;</span><br />{snippet}</div><div className="copy-row"><span className="copy-confirm" aria-live="polite">{copied ? 'Copied to clipboard' : 'Ready to copy'}</span><button className="button button-quiet" data-testid="button-copy-embed" onClick={() => void copy()}>{copied ? <ClipboardCheck size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy snippet'}</button></div><p className="field-note" style={{ marginTop: 20 }}>The 900px iframe has its own scroll area. Do not change its source URL; the profile ID associates requests with your account.</p></section>
      <section className="card preview-card"><div className="preview-top"><div><div className="eyebrow">Public widget address</div><h2 style={{ marginTop: 7, marginBottom: 0 }}>{profile.companyName}</h2></div><span className="pill">Live</span></div><div className="mini-widget"><p style={{ overflowWrap: 'anywhere' }}>{widgetUrl}</p><div className="mock-cta" /></div><div style={{ padding: '0 21px 21px' }}><Link href={`/widget/${encodeURIComponent(profile.id)}`} className="button button-primary" style={{ width: '100%' }} data-testid="button-open-widget">Open homeowner widget <ExternalLink size={15} /></Link></div></section>
    </div>}
  </main></div>;
}

function RoomIcon({ room }: { room: RoomType }) {
  if (room === 'bathroom') return <Bath size={23} />;
  if (room === 'bedroom') return <BedDouble size={23} />;
  if (room === 'living-room') return <Sofa size={23} />;
  if (room === 'other') return <LayoutTemplate size={23} />;
  return <Hammer size={23} />;
}

function PublicWidget({ id }: { id: string }) {
  const [profile, setProfile] = useState<PublicWidgetProfile | null>(null);
  const [loadError, setLoadError] = useState('');
  const [stage, setStage] = useState<'room' | 'upload' | 'results' | 'contact' | 'submitted'>('room');
  const [room, setRoom] = useState<RoomType>('kitchen');
  const [file, setFile] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [brief, setBrief] = useState('');
  const [contact, setContact] = useState<Homeowner>(emptyHomeowner);
  const [redesign, setRedesign] = useState<PublicRedesign | null>(null);
  const [receipt, setReceipt] = useState<PublicRequestReceipt | null>(null);
  const [requestKey, setRequestKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attemptLocked, setAttemptLocked] = useState(false);
  const keyStorageName = `visual-quote-request-key:${id}`;
  const changedAttempt = () => {
    setRequestKey('');
    try { sessionStorage.removeItem(keyStorageName); } catch { /* session storage is optional */ }
  };
  const changedDesign = () => {
    changedAttempt();
    setRedesign(null);
    setReceipt(null);
  };
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/widget/${encodeURIComponent(id)}`).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, 'This contractor widget is unavailable. Check the link or contact the contractor.'));
      if (typeof data.id !== 'string' || typeof data.companyName !== 'string' || typeof data.accentColor !== 'string') {
        throw new Error('The widget settings response is incomplete. Please try again later.');
      }
      return data as PublicWidgetProfile;
    }).then((data) => { if (!cancelled) setProfile(data); })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Could not load this contractor widget.'); });
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => {
    if (!photoUrl) return;
    return () => URL.revokeObjectURL(photoUrl);
  }, [photoUrl]);
  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selectedFile.type)) {
      setError('Choose a JPG, PNG, or WebP interior photo. Other file types cannot be redesigned.');
      setFile(null); setPhotoUrl('');
      event.target.value = '';
      return;
    }
    if (selectedFile.size > 10 * 1024 * 1024) {
      setError('Choose a photo smaller than 10 MB, then try again.');
      setFile(null); setPhotoUrl('');
      event.target.value = '';
      return;
    }
    setError('');
    changedDesign();
    setFile(selectedFile);
    setPhotoUrl(URL.createObjectURL(selectedFile));
  };
  const createDesign = async () => {
    if (!profile || !file || busy) {
      if (!file) setError('Upload a photo of your room before creating a design direction.');
      return;
    }
    if (brief.trim().length < 3) {
      setError('Describe what you would like to change in at least a few words.');
      return;
    }
    setBusy(true); setError('');
    try {
      const body = new FormData();
      body.append('image', file);
      body.append('roomType', room);
      body.append('designBrief', brief.trim());
      const response = await fetch(`/api/widget/${encodeURIComponent(id)}/redesign`, { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, 'The AI redesign could not be created. Check your connection and try again.'));
      if (typeof data.imageBase64 !== 'string' || typeof data.mimeType !== 'string' || !Array.isArray(data.checklist) || typeof data.designSummary !== 'string' || typeof data.redesignToken !== 'string') {
        throw new Error('The redesign service returned incomplete results. Please retry or contact the contractor.');
      }
      setRedesign(data as PublicRedesign);
      setStage('results');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The AI redesign could not be created. Please try again.');
    } finally { setBusy(false); }
  };
  const submitRequest = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile || !file || !redesign || busy) return;
    setBusy(true); setError('');
    try {
      let stableKey = requestKey;
      if (!stableKey) {
        try {
          stableKey = sessionStorage.getItem(keyStorageName) || crypto.randomUUID();
          sessionStorage.setItem(keyStorageName, stableKey);
        } catch {
          stableKey = crypto.randomUUID();
        }
        setRequestKey(stableKey);
      }
      const redesignBytes = Uint8Array.from(atob(redesign.imageBase64), (character) => character.charCodeAt(0));
      const redesignBlob = new Blob([redesignBytes], { type: redesign.mimeType });
      const body = new FormData();
      body.append('original', file);
      body.append('redesign', new File([redesignBlob], `room-redesign.${redesign.mimeType.split('/')[1] || 'png'}`, { type: redesign.mimeType }));
      body.append('roomType', room);
      body.append('designBrief', brief.trim());
      body.append('homeownerName', contact.name.trim());
      body.append('homeownerEmail', contact.email.trim());
      body.append('homeownerPhone', contact.phone.trim());
      body.append('homeownerNotes', contact.notes.trim());
      body.append('redesignToken', redesign.redesignToken);
      body.append('requestKey', stableKey);
      setAttemptLocked(true);
      const response = await fetch(`/api/widget/${encodeURIComponent(id)}/requests`, { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 400 || response.status === 404) setAttemptLocked(false);
        throw new Error(apiMessage(data, 'Delivery is not confirmed. Retry this exact request; do not start a new submission while the outcome is uncertain.'));
      }
      if (typeof data.referenceId !== 'string' || !data.referenceId || typeof data.requestId !== 'string' || !data.requestId || typeof data.deletionToken !== 'string' || !data.deletionToken) {
        throw new Error('The request service did not confirm delivery and provide a private deletion link. Your form is still available to retry.');
      }
      setReceipt(data as PublicRequestReceipt);
      try { sessionStorage.removeItem(keyStorageName); } catch { /* session storage is optional */ }
      setStage('submitted');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your request could not be sent. Please retry.');
    } finally { setBusy(false); }
  };
  const updateContact = (field: keyof Homeowner, value: string) => {
    if (attemptLocked) return;
    changedAttempt();
    setContact((current) => ({ ...current, [field]: value }));
  };
  const reset = () => {
    setStage('room'); setRoom('kitchen'); setFile(null); setPhotoUrl(''); setBrief(''); setContact(emptyHomeowner);
    setRedesign(null); setReceipt(null); setRequestKey(''); setError(''); setAttemptLocked(false);
    try { sessionStorage.removeItem(keyStorageName); } catch { /* session storage is optional */ }
  };
  if (!profile) return <main className="public-widget-state">{loadError ? <div className="error-banner" role="alert">{loadError}</div> : <p role="status">Loading contractor widget…</p>}</main>;
  const brand = { companyName: profile.companyName, accentColor: profile.accentColor, logoInitials: initials(profile.companyName) };
  const redesignUrl = redesign ? `data:${redesign.mimeType};base64,${redesign.imageBase64}` : '';
  const stageTitles = { room: 'Choose room', upload: 'Add your photo', results: 'Review design', contact: 'Send request', submitted: 'Request sent' };
  return <div className="widget-page" style={{ '--widget-accent': profile.accentColor } as CSSProperties}>
    <div className="widget-wrap public-widget-wrap">
      <div className="widget-top"><Brand config={brand} /><span className="pill"><span style={{ width: 6, height: 6, borderRadius: '50%', background: profile.accentColor }} /> {stageTitles[stage]}</span></div>
      <div className="widget-card fade-in">
        {stage === 'room' && <div className="widget-body"><div className="eyebrow">A visual starting point from {profile.companyName}</div><h1 className="display">What room are you planning?</h1><p>Choose any interior room, then share a photo and the changes you have in mind.</p><div className="room-grid">{(Object.keys(roomLabels) as RoomType[]).map((item) => <button type="button" className={`room-option ${room === item ? 'selected' : ''}`} key={item} data-testid={`button-room-${item}`} onClick={() => { if (room !== item) changedDesign(); setRoom(item); }}><div className="room-icon"><RoomIcon room={item} /></div><strong>{item === 'other' ? 'Other interior room' : roomLabels[item]}</strong><span>{item === 'other' ? 'Any indoor space' : 'Interior project'}</span></button>)}</div><div className="stage-actions"><span className="muted">About 2 minutes · no account required</span><button className="button button-primary" data-testid="button-continue-room" onClick={() => setStage('upload')}>Continue <ArrowRight size={15} /></button></div></div>}
        {stage === 'upload' && <div className="widget-body"><div className="eyebrow">Step 2 · {roomLabels[room]}</div><h1 className="display">Bring your room into focus.</h1><p>Upload a clear JPG, PNG, or WebP photo (up to 10 MB). Your photo is required to create a real AI redesign.</p><div className="public-upload-grid"><label className="upload-box file-button public-upload-box"><CloudUpload size={28} /><strong>{file ? 'Photo ready' : 'Upload your room photo'}</strong><p>{file ? file.name : 'Your photo, not a sample, will be used for the redesign.'}</p><span className="button button-quiet">{file ? 'Choose another photo' : 'Choose photo'}<input type="file" accept="image/jpeg,image/png,image/webp" data-testid="input-room-photo" onChange={choosePhoto} /></span></label>{photoUrl ? <img className="public-photo-preview" src={photoUrl} alt="Uploaded interior room photo preview" /> : <div className="sample-preview-label"><img src={KITCHEN_IMAGE} alt="Example kitchen photo only; not used for your redesign" /><span>Example photo only · upload your own image to continue</span></div>}</div><div className="field design-brief"><label htmlFor="design-brief-public">What would you like to change?</label><textarea id="design-brief-public" data-testid="input-design-brief" maxLength={500} value={brief} onChange={(event) => { changedDesign(); setBrief(event.target.value); }} placeholder="For example: brighter finishes, more storage, and warm natural materials." required /></div>{error && <div className="error-banner" role="alert">{error}</div>}<div className="stage-actions"><button className="button button-ghost" onClick={() => setStage('room')}><ArrowLeft size={15} /> Back</button><button className="button button-primary" data-testid="button-create-redesign" disabled={!file || busy} onClick={() => void createDesign()}>{busy ? <><LoaderCircle size={15} className="spin" /> Creating design…</> : <>Create my design <Sparkles size={15} /></>}</button></div></div>}
        {stage === 'results' && redesign && <div className="widget-body"><div className="eyebrow">AI concept · {roomLabels[room]}</div><h1 className="display">A direction to react to.</h1><p>Your AI-edited photo and planning notes are conversation starters, not a quote or construction plan.</p><div className="result-grid"><div className="visual-compare"><div className="visual-pane original" style={{ backgroundImage: `url(${photoUrl})` }} /><div className="visual-pane redesign" style={{ backgroundImage: `url(${redesignUrl})` }} /></div><div className="result-copy"><div className="pill" style={{ marginBottom: 13 }}>Your requested direction</div><h3>{roomLabels[room]} / AI concept</h3><p>{redesign.designSummary}</p></div></div><div className="card checklist"><h3>Project checklist <span className="pill">{redesign.checklist.length} notes</span></h3><ul>{redesign.checklist.map((item, index) => <li key={`${index}-${item}`}><SquareCheck size={14} />{item}</li>)}</ul></div><div className="disclaimer" style={{ marginTop: 16 }}>The AI concept is an early visual reference, not a measured plan, quote, feasibility review, or promise of outcome. Your contractor will verify conditions and pricing.</div><div className="stage-actions"><button className="button button-ghost" onClick={() => setStage('upload')}><ArrowLeft size={15} /> Edit details</button><button className="button button-primary" data-testid="button-request-conversation" onClick={() => setStage('contact')}>Request a conversation <ArrowRight size={15} /></button></div></div>}
        {stage === 'contact' && <form className="widget-body" onSubmit={(event) => void submitRequest(event)}><div className="eyebrow">Almost there</div><h1 className="display">Where should they pick this up?</h1><p>Share your contact details so {profile.companyName} can follow up about your {roomLabels[room].toLowerCase()}.</p><div className="contact-layout"><fieldset className="contact-fields" disabled={attemptLocked}><div className="field"><label htmlFor="homeowner-name">Your name</label><input id="homeowner-name" data-testid="input-homeowner-name" value={contact.name} onChange={(event) => updateContact('name', event.target.value)} autoComplete="name" required /></div><div className="field-grid"><div className="field"><label htmlFor="homeowner-email">Email</label><input id="homeowner-email" data-testid="input-homeowner-email" type="email" value={contact.email} onChange={(event) => updateContact('email', event.target.value)} autoComplete="email" required /></div><div className="field"><label htmlFor="homeowner-phone">Phone <span className="muted">(optional)</span></label><input id="homeowner-phone" data-testid="input-homeowner-phone" value={contact.phone} onChange={(event) => updateContact('phone', event.target.value)} autoComplete="tel" /></div></div><div className="field"><label htmlFor="homeowner-notes">Anything else to know? <span className="muted">(optional)</span></label><textarea id="homeowner-notes" data-testid="input-homeowner-notes" value={contact.notes} onChange={(event) => updateContact('notes', event.target.value)} /></div></fieldset><aside className="contact-note"><strong>What gets sent</strong><p>Your contact details, notes, room photo, AI redesign, and project brief will be sent to {profile.companyName}.</p><div className="disclaimer">Your details are shared with this contractor to respond to your request.</div></aside></div>{attemptLocked && <p className="field-note" role="status">The first delivery attempt has already started. Retry these exact details to avoid a duplicate email.</p>}{error && <div className="error-banner" role="alert">{error}</div>}<div className="stage-actions"><button type="button" className="button button-ghost" disabled={attemptLocked} onClick={() => setStage('results')}><ArrowLeft size={15} /> Back</button><button type="submit" className="button button-primary" data-testid="button-submit-request" disabled={busy}>{busy ? 'Sending request…' : <>Send request <Send size={15} /></>}</button></div></form>}
        {stage === 'submitted' && receipt && <div className="confirm slide-up"><div className="confirm-mark"><Check size={30} /></div><div className="eyebrow">Email accepted</div><h1 className="display">Your request is on its way.</h1><p>{profile.companyName} accepted your request for delivery. Keep this reference for your records.</p><div className="reference"><FileImage size={14} /> Reference {receipt.referenceId}</div><div className="card deletion-link-card"><strong>Delete your request</strong><p className="muted">Use this private link to remove your request and photos.</p><a href={`${basePath}/delete-request/${encodeURIComponent(receipt.requestId)}#${receipt.deletionToken}`}>Open private deletion page</a></div><div className="stage-actions" style={{ justifyContent: 'center', marginTop: 29 }}><button className="button button-quiet" data-testid="button-reset-widget" onClick={reset}>Start another request</button></div></div>}
      </div>
      {error && stage === 'submitted' && <div className="error-banner" role="alert">{error}</div>}
      <div className="widget-disclaimer"><ShieldCheck size={13} /> Your photo and contact details are sent only with your request to this contractor.</div>
    </div>
  </div>;
}

function LegacyWidgetRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation('/contractor-setup?notice=legacy-widget', { replace: true });
  }, [setLocation]);
  return <main className="public-widget-state"><p role="status">This legacy Benchmark link has no tenant ID. Redirecting to contractor settings; generate a current widget URL there.</p></main>;
}

function WidgetPage({ config, session, setSession }: { config: ContractorConfig; session: DemoSession; setSession: (value: DemoSession) => void }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { allowance, loading, refresh } = useAllowance();
  const [flow, setFlow] = useState<FlowStatus>('welcome');
  const [room, setRoom] = useState<RoomType>(session.roomType);
  const [uploaded, setUploaded] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [designBrief, setDesignBrief] = useState(session.designBrief || 'Warm natural materials, practical storage, and soft layered lighting.');
  const [contact, setContact] = useState<Homeowner>(session.homeowner);
  const [progressStep, setProgressStep] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  const processingLabels = ['Reviewing your photo', 'Creating a design direction', 'Building a rough checklist', 'Ready to review'];
  useEffect(() => {
    if (flow !== 'processing') return;
    setProgressStep(0);
    const timers = [900, 3500, 9000].map((delay, index) => window.setTimeout(() => setProgressStep(index + 1), delay));
    return () => { timers.forEach(window.clearTimeout); };
  }, [flow]);
  const updateContact = (field: keyof Homeowner, value: string) => setContact((current) => ({ ...current, [field]: value }));
  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Choose a JPG, PNG, or WebP room photo.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Choose a room photo under 10 MB.'); return; }
    setError('');
    const url = URL.createObjectURL(file);
    setUploaded(true);
    setSelectedFile(file);
    setSession({ ...session, originalImageUrl: url, originalImageName: file.name, roomType: room });
  };
  const createRedesign = async () => {
    if (!isLoaded || !isSignedIn || loading || !allowance || allowance.remaining < 1) return;
    if (designBrief.trim().length < 3) {
      setError('Add a short note about what you would like to change.');
      return;
    }
    setError('');
    setFlow('processing');
    try {
      let image = selectedFile;
      if (!image) {
        const sample = await fetch(KITCHEN_IMAGE);
        if (!sample.ok) throw new Error('The sample photo could not be loaded.');
        image = new File([await sample.blob()], 'benchmark-kitchen-sample.jpg', { type: 'image/jpeg' });
      }
      const body = new FormData();
      body.append('image', image);
      body.append('roomType', room);
      body.append('designBrief', designBrief.trim());
      const response = await fetch('/api/redesigns', { method: 'POST', body });
      const data = await response.json() as RedesignResponse | ApiErrorResponse;
      if (!response.ok || !('imageBase64' in data)) {
        throw new Error('error' in data && data.error ? data.error : 'The redesign could not be created.');
      }
      const redesignImageUrl = `data:${data.mimeType};base64,${data.imageBase64}`;
      setProgressStep(4);
      setSession({
        ...session,
        roomType: room,
        designBrief: designBrief.trim(),
        flowStatus: 'results',
        redesignImageUrl,
        designSummary: `A concept direction shaped around your request: ${designBrief.trim()}`,
        checklist: checklistTemplates[room],
        originalImageUrl: uploaded && session.originalImageUrl ? session.originalImageUrl : KITCHEN_IMAGE,
      });
      setFlow('results');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The redesign could not be created. Please try again.');
      setFlow('upload');
    } finally {
      void refresh();
    }
  };
  const submitContact = async (event: FormEvent) => {
    event.preventDefault();
    if (!contact.name || !contact.email || !isSignedIn || saving) return;
    setSaving(true); setError('');
    try {
      let original = selectedFile;
      if (!original) {
        const sample = await fetch(KITCHEN_IMAGE);
        if (!sample.ok) throw new Error('The sample photo could not be loaded.');
        original = new File([await sample.blob()], 'sample.jpg', { type: 'image/jpeg' });
      }
      if (!session.redesignImageUrl.startsWith('data:image/png;base64,')) throw new Error('Create a design direction first.');
      const concept = await fetch(session.redesignImageUrl);
      const body = new FormData();
      body.append('original', original);
      body.append('redesign', new File([await concept.blob()], 'concept.png', { type: 'image/png' }));
      body.append('roomType', room);
      body.append('designBrief', designBrief.trim());
      body.append('homeownerName', contact.name.trim());
      body.append('homeownerEmail', contact.email.trim());
      body.append('homeownerPhone', contact.phone);
      body.append('homeownerNotes', contact.notes);
      const response = await fetch('/api/visual-requests', { method: 'POST', body });
      const data = await response.json() as SaveReceipt & ApiErrorResponse;
      if (!response.ok) throw new Error(data.error || 'The request could not be saved.');
      setReceipt(data);
      setSession({ ...session, homeowner: contact, flowStatus: 'submitted', contractorUserId: userId ?? undefined, referenceId: data.request.id.slice(0, 8).toUpperCase(), originalImageUrl: data.request.originalImageUrl, redesignImageUrl: data.request.redesignImageUrl });
      setFlow('submitted');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request could not be saved.');
    } finally { setSaving(false); }
  };
  const resetFlow = () => { setContact(emptyHomeowner); setUploaded(false); setSelectedFile(null); setReceipt(null); setDesignBrief('Warm natural materials, practical storage, and soft layered lighting.'); setError(''); setFlow('welcome'); setSession(createSession(config)); };
  const currentOriginal = uploaded ? session.originalImageUrl : KITCHEN_IMAGE;
  const stepLabel = useMemo(() => ({ welcome: 'Welcome', room: 'Choose room', upload: 'Add context', processing: 'Preparing direction', results: 'Review direction', contact: 'Send request', submitted: 'Sent' }[flow]), [flow]);
  return <div className="widget-page" style={{ '--widget-accent': config.accentColor } as CSSProperties}>
    <div className="widget-wrap">
      <div className="widget-top"><Link href="/" data-testid="link-widget-back"><Brand config={config} /></Link><span className="pill"><span style={{ width: 6, height: 6, borderRadius: '50%', background: config.accentColor }} /> {stepLabel}</span></div>
      <div className="widget-card fade-in">
        {flow === 'welcome' && <><div className="widget-hero"><div><div className="eyebrow">A visual starting point from {config.companyName}</div><h1 className="display">Let’s talk about the room.</h1><p>Share a photo and a little context. We’ll turn it into a rough design direction you can review before requesting a conversation.</p></div></div><div className="widget-body"><div className="stage-actions" style={{ marginTop: 0 }}><span className="muted" style={{ fontSize: 12 }}><ShieldCheck size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Contractor sign-in needed to generate and save · about 2 minutes</span><button className="button button-primary" data-testid="button-start-journey" onClick={() => setFlow('room')}>Start with the room <ArrowRight size={16} /></button></div></div></>}
        {flow === 'room' && <div className="widget-body slide-up"><div className="eyebrow">Step 1 / 3</div><h2>What are we looking at?</h2><p>Choose the closest fit. It helps us keep the visual direction and planning notes relevant.</p><div className="room-grid">{(Object.keys(roomLabels) as RoomType[]).map((item) => <button type="button" className={`room-option ${room === item ? 'selected' : ''}`} key={item} data-testid={`button-room-${item}`} onClick={() => setRoom(item)}><div className="room-icon"><RoomIcon room={item} /></div><strong>{roomLabels[item]}</strong><span>{item === 'other' ? 'Tell us more later' : 'A focused starting point'}</span></button>)}</div><div className="stage-actions"><button className="button button-ghost" data-testid="button-back-welcome" onClick={() => setFlow('welcome')}><ArrowLeft size={15} /> Back</button><button className="button button-primary" data-testid="button-continue-room" onClick={() => { setSession({ ...session, roomType: room }); setFlow('upload'); }}>Continue <ArrowRight size={15} /></button></div></div>}
        {flow === 'upload' && <div className="widget-body slide-up"><div className="eyebrow">Step 2 / 3</div><h2>Bring a little context.</h2><p>Use the sample or add your own room photo. The photo is processed for an AI redesign. If you submit a request, the contractor keeps both images and your contact details privately for up to 90 days. You can delete sooner with the link shown after submitting.</p><div className="upload-stage"><label className="upload-box file-button"><CloudUpload size={28} /><strong>{uploaded ? 'Photo added' : 'Add your room photo'}</strong><p>{uploaded ? session.originalImageName : 'JPG, PNG, or WebP · up to 10 MB.'}</p><span className="button button-quiet">{uploaded ? 'Choose another' : 'Choose image'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={onUpload} /></span></label><button type="button" className="sample-box" data-testid="button-use-sample" onClick={() => { setUploaded(false); setSelectedFile(null); setSession({ ...session, originalImageUrl: KITCHEN_IMAGE, originalImageName: 'benchmark-kitchen-sample.jpg', roomType: room }); }}><div className="sample-box-content"><strong>Use the sample project</strong><p>Warm kitchen / natural materials</p></div></button></div><div className="field design-brief"><label htmlFor="design-brief">What would you like to change?</label><textarea id="design-brief" data-testid="input-design-brief" maxLength={500} value={designBrief} onChange={(event) => setDesignBrief(event.target.value)} placeholder="For example: lighter oak cabinets, warm stone surfaces, and softer lighting. Keep the existing layout." /><span className="field-note">The AI will preserve the room’s perspective and major structure while applying this direction.</span></div><AccessPanel allowance={allowance} loading={loading} />{error && <div className="error-banner" role="alert">{error}</div>}<div className="stage-actions"><button className="button button-ghost" data-testid="button-back-room" onClick={() => setFlow('room')}><ArrowLeft size={15} /> Back</button><div className="right-actions"><button disabled={!isSignedIn || loading || !allowance?.remaining} className="button button-primary" data-testid="button-review-photo" onClick={createRedesign}>Create my direction <Sparkles size={15} /></button></div></div></div>}
        {flow === 'processing' && <div className="widget-body progress-stage slide-up"><div className="pill" style={{ marginBottom: 19 }}><LoaderCircle className="spin" size={13} /> Secure AI image edit</div><h2>Making the first pass.</h2><p>OpenAI is editing the source photo while keeping the room’s viewpoint and major architecture in place. This can take up to two minutes.</p><div className="progress-bar"><div className="progress-fill progress-fill-live" style={{ width: `${Math.max(12, Math.min(progressStep, 3) * 28)}%` }} /></div><div className="progress-list">{processingLabels.map((label, index) => <div className={`progress-item ${progressStep > index ? 'done' : ''} ${progressStep === index ? 'active' : ''}`} key={label}>{progressStep > index ? <Check size={15} /> : progressStep === index ? <LoaderCircle className="spin" size={15} /> : <span style={{ width: 15, height: 15, border: '1px solid hsl(var(--border))', borderRadius: '50%' }} />}{label}</div>)}</div></div>}
        {flow === 'results' && <div className="widget-body slide-up"><div className="eyebrow">Step 3 / 3 · AI concept</div><h2>A direction to react to.</h2><p>Here’s an AI-edited conversation starter for your {roomLabels[room].toLowerCase()}. Your contractor still verifies scope, measurements, and feasibility.</p><div className="result-grid"><div className="visual-compare"><div className="visual-pane original" style={{ backgroundImage: `url(${currentOriginal})` }} /><div className="visual-pane redesign" style={{ backgroundImage: `url(${session.redesignImageUrl})` }} /></div><div className="result-copy"><div className="pill" style={{ marginBottom: 13 }}>Your requested direction</div><h3>{roomLabels[room]} / AI concept</h3><p>{session.designSummary || designSummaries[room]}</p></div></div><div className="result-sections"><div className="card checklist"><h3>Rough project checklist <span className="pill">4 notes</span></h3><ul>{(session.checklist.length ? session.checklist : checklistTemplates[room]).map((item) => <li key={item}><SquareCheck size={14} />{item}</li>)}</ul></div><div className="card checklist"><h3>Before we talk scope</h3><div className="disclaimer">This AI image is an early visual concept, not a measured plan, quote, feasibility review, or promise of outcome. The contractor will verify all conditions and pricing.</div><p className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 0 }}>Like the direction? Send your details and {config.companyName} can pick up the thread.</p></div></div><div className="stage-actions"><button className="button button-ghost" data-testid="button-start-over" onClick={resetFlow}><RefreshCcw size={15} /> Start over</button><button className="button button-primary" data-testid="button-request-conversation" onClick={() => setFlow('contact')}>Request a conversation <ArrowRight size={15} /></button></div></div>}
        {flow === 'contact' && <form className="widget-body slide-up" onSubmit={submitContact}><div className="eyebrow">Almost there</div><h2>Where should they pick this up?</h2><p>Share the details you’re comfortable with. This demo will show you exactly what the contractor would receive.</p><div className="contact-layout"><div><div className="field"><label htmlFor="homeowner-name">Your name</label><input id="homeowner-name" data-testid="input-homeowner-name" value={contact.name} onChange={(event) => updateContact('name', event.target.value)} placeholder="e.g. Mia Chen" required /></div><div className="field-grid"><div className="field"><label htmlFor="homeowner-email">Email</label><input id="homeowner-email" data-testid="input-homeowner-email" type="email" value={contact.email} onChange={(event) => updateContact('email', event.target.value)} placeholder="mia@example.com" required /></div><div className="field"><label htmlFor="homeowner-phone">Phone <span className="muted">(optional)</span></label><input id="homeowner-phone" data-testid="input-homeowner-phone" value={contact.phone} onChange={(event) => updateContact('phone', event.target.value)} placeholder="04xx xxx xxx" /></div></div><div className="field"><label htmlFor="homeowner-notes">What should they know?</label><textarea id="homeowner-notes" data-testid="input-homeowner-notes" value={contact.notes} onChange={(event) => updateContact('notes', event.target.value)} placeholder="Timing, what isn’t working, or what you want to keep..." /></div></div><aside className="contact-note"><strong>Your request, in plain English.</strong><p>{roomLabels[room]} direction, rough checklist, your original image, and the details you add here.</p><div className="disclaimer">No email is sent in this prototype. We’ll show the contractor preview next.</div></aside></div><div className="stage-actions"><button type="button" className="button button-ghost" data-testid="button-back-results" onClick={() => setFlow('results')}><ArrowLeft size={15} /> Back</button><button type="submit" className="button button-primary" data-testid="button-submit-request">Show contractor preview <Send size={15} /></button></div></form>}
        {flow === 'submitted' && <div className="confirm slide-up"><div className="confirm-mark"><Check size={30} /></div><div className="eyebrow">Request saved privately</div><h2 className="display">That’s a clearer brief.</h2><p>{config.companyName} can revisit this request in their signed-in workspace. No email has been sent. Save the deletion link below if you want to remove your details and photos sooner.</p><div className="reference"><FileImage size={14} /> Reference {session.referenceId}</div><div className="stage-actions" style={{ justifyContent: 'center', marginTop: 29 }}><Link href="/contractor-email" className="button button-primary" data-testid="button-view-email">View contractor preview <Mail size={15} /></Link><button className="button button-quiet" data-testid="button-reset-widget" onClick={resetFlow}>Start another request</button></div></div>}
      </div>
      {error && flow === 'contact' && <div className="error-banner" role="alert">{error}</div>}
      {receipt && flow === 'submitted' && <div className="card" style={{ padding: 20, marginTop: 20 }}>
        <strong>Keep your deletion link</strong>
        <p className="muted">Your request and both photos are kept privately for 90 days, then automatically removed. The contractor can delete it sooner. You can delete it yourself using this private link. It is shown only now; save it before leaving. No email has been sent.</p>
        <button className="button button-quiet" type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(`${window.location.origin}${basePath}/delete-request/${receipt.request.id}#${receipt.deletionToken}`); }
          catch { setError('Could not copy. Please use the link below.'); }
        }}>Copy deletion link</button>
        <p style={{ overflowWrap: 'anywhere', fontSize: 12 }}><a href={`${basePath}/delete-request/${receipt.request.id}#${receipt.deletionToken}`}>Open your deletion page</a></p>
      </div>}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 7, color: 'hsl(var(--muted-foreground))', fontSize: 11, marginTop: 18 }}><ShieldCheck size={13} /> Previews are temporary. Submitted requests, photos, and contact details are private and kept for 90 days; the contractor or homeowner can delete sooner.</div>
    </div>
  </div>;
}

function ContractorEmail({ config, session }: { config: ContractorConfig; session: DemoSession }) {
  const checklist = session.checklist.length ? session.checklist : checklistTemplates[session.roomType];
  return <div className="app-shell"><ProductHeader active={3} config={config} /><main className="page-frame email-wrap"><div className="workspace-head"><div className="eyebrow">Contractor workspace / 04</div><h1 className="display">The lead, without the fog.</h1><p>A realistic inbox preview populated from the demo journey. Nothing has been emailed.</p></div><div className="email-layout"><article className="email-shell"><div className="email-toolbar"><span><Mail size={13} style={{ verticalAlign: 'middle', marginRight: 7 }} /> Incoming visual quote request</span><span className="pill">Demo preview</span></div><div className="email-body"><div className="email-meta"><div className="email-meta-row"><span className="email-meta-label">To</span><strong>{config.quoteEmail}</strong></div><div className="email-meta-row"><span className="email-meta-label">From</span><span>{session.homeowner.email || 'homeowner@example.com'}</span></div><div className="email-meta-row"><span className="email-meta-label">Reply</span><span>{session.homeowner.name || 'Demo homeowner'} · {session.homeowner.phone || 'No phone added'}</span></div></div><h2 className="email-subject">New visual quote request for a {roomLabels[session.roomType].toLowerCase()}</h2><p>Hi {config.companyName},</p><p><strong>{session.homeowner.name || 'A homeowner'}</strong> has used your visual quote intake to start a conversation about their {roomLabels[session.roomType].toLowerCase()}.</p>{session.homeowner.notes && <p><strong>Their note:</strong> “{session.homeowner.notes}”</p>}<div className="email-images"><div className="email-image original" data-label="Original room" style={{ backgroundImage: `url(${session.originalImageUrl || KITCHEN_IMAGE})` }} /><div className="email-image redesign" data-label="Design direction" style={{ backgroundImage: `url(${session.redesignImageUrl || LIVING_IMAGE})` }} /></div><div className="email-checklist"><h3>Rough checklist · {roomLabels[session.roomType]}</h3>{checklist.map((item) => <div key={item}><Check size={14} />{item}</div>)}</div><p className="muted" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 25 }}>This visual direction and checklist are rough planning aids only. Verify measurements, conditions, scope, materials, timing, and pricing before relying on them.</p><p>Best,<br />Build / quote intake</p></div></article><aside className="card email-side"><h3>Lead snapshot</h3><dl><div><dt>Reference</dt><dd className="mono">{session.referenceId}</dd></div><div><dt>Homeowner</dt><dd data-testid="text-email-homeowner">{session.homeowner.name || 'Demo homeowner'}<br />{session.homeowner.email || 'homeowner@example.com'}</dd></div><div><dt>Room</dt><dd>{roomLabels[session.roomType]}</dd></div><div><dt>Original file</dt><dd>{session.originalImageName}</dd></div><div><dt>Next step</dt><dd>Review scope and reply personally.</dd></div></dl><Link href="/contractor-setup" className="button button-quiet" style={{ width: '100%', marginTop: 25 }} data-testid="button-return-widget"><RefreshCcw size={14} /> Open contractor setup</Link></aside></div></main></div>;
}

function RequestHistory({ config }: { config: ContractorConfig }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [requests, setRequests] = useState<SavedRequest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setRequests([]); setSelected(null); setError('');
    if (!isLoaded || !isSignedIn) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch('/api/visual-requests').then(async (response) => {
      if (!response.ok) throw new Error('Could not load saved requests.');
      return response.json() as Promise<SavedRequest[]>;
    }).then((rows) => { if (!cancelled) setRequests(rows); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load requests.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, userId]);
  const active = requests.find((item) => item.id === selected);
  const remove = async (id: string) => {
    if (!window.confirm('Permanently delete this request, contact details, and both photos? This cannot be undone.')) return;
    setError('');
    try {
      const result = await fetch(`/api/visual-requests/${id}`, { method: 'DELETE' });
      if (!result.ok) throw new Error('Could not delete this request. Please try again.');
      setRequests((current) => current.filter((item) => item.id !== id));
      setSelected(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Deletion failed.'); }
  };
  return <div className="app-shell"><ProductHeader active={3} config={config} /><main className="page-frame workspace">
    <div className="workspace-head"><div className="eyebrow">Contractor workspace / saved leads</div><h1 className="display">Saved requests.</h1><p>Only requests submitted to your signed-in account appear here. Contact details and original and concept images are private. Each request is removed after 90 days; you can delete it sooner.</p></div>
    {!isLoaded ? <p>Checking access…</p> : !isSignedIn ? <div className="card" style={{ padding: 25 }}><p>Sign in to see your own requests.</p><Link className="button button-primary" href="/sign-in">Sign in</Link></div> :
    <div className="two-col"><div className="card" style={{ padding: 25 }}>
      {loading ? <p>Loading requests…</p> : requests.length === 0 && !error ? <p>No saved requests yet. A request appears here once the homeowner submits their contact details.</p> : requests.map((item) => <div key={item.id} style={{ borderBottom: '1px solid hsl(var(--border))', padding: '15px 0' }}>
        <strong>{item.homeownerName} · {roomLabels[item.roomType]}</strong><p className="muted" style={{ margin: '5px 0' }}>{new Date(item.createdAt).toLocaleDateString()} · {item.homeownerEmail}</p>
        <button type="button" className="button button-quiet" onClick={() => setSelected(item.id)}>Review request</button>
      </div>)}
      {error && <p role="alert" className="error-banner">{error}</p>}
    </div><div className="card" style={{ padding: 25 }}>
      {active ? <><div className="eyebrow">Request {active.id.slice(0, 8).toUpperCase()}</div><h2>{active.homeownerName}</h2><p><a href={`mailto:${active.homeownerEmail}`}>{active.homeownerEmail}</a>{active.homeownerPhone && <> · {active.homeownerPhone}</>}</p><p><strong>Direction:</strong> {active.designBrief}</p>{active.homeownerNotes && <p><strong>Homeowner note:</strong> {active.homeownerNotes}</p>}
        <div className="result-grid"><div><p>Original photo</p><img src={active.originalImageUrl} alt="Original room" style={{ width: '100%', borderRadius: 10 }} /></div><div><p>AI concept</p><img src={active.redesignImageUrl} alt="Redesigned room" style={{ width: '100%', borderRadius: 10 }} /></div></div>
        <p className="field-note">Automatically deleted {new Date(active.expiresAt).toLocaleDateString()}.</p>
        <button type="button" className="button button-ghost" onClick={() => void remove(active.id)}>Delete request and photos</button>
      </> : <p className="muted">Choose a request to review its details and private images.</p>}
    </div></div>}
  </main></div>;
}

function HomeownerDelete({ id }: { id: string }) {
  const [state, setState] = useState<'ready' | 'deleting' | 'deleted'>('ready');
  const [error, setError] = useState('');
  const token = window.location.hash.slice(1);
  const remove = async () => {
    if (!window.confirm('Delete your request, contact details, and both photos permanently? This cannot be undone.')) return;
    setState('deleting'); setError('');
    try {
      const response = await fetch(`/api/visual-requests/${id}/homeowner-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletionToken: token }) });
      if (!response.ok) throw new Error('This deletion link is invalid, expired, or already used. Ask the contractor to delete the request if needed.');
      window.history.replaceState(null, '', `${basePath}/delete-request/${id}`);
      setState('deleted');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Deletion failed.'); setState('ready'); }
  };
  return <div className="app-shell"><MarketingHeader /><main className="page-frame workspace"><div className="card" style={{ padding: 30, maxWidth: 620, margin: 'auto' }}>
    <h1>Delete your visual quote request</h1>
    {state === 'deleted' ? <p>Your contact details and both photos have been deleted.</p> : <><p>This private link lets you permanently delete the request and its original and generated images before the 90-day automatic removal date. It cannot be undone.</p>
      {!token ? <p role="alert">This link is missing its private deletion code.</p> : <button className="button button-primary" disabled={state === 'deleting'} onClick={() => void remove()}>{state === 'deleting' ? 'Deleting…' : 'Delete my request and photos'}</button>}</>}
    {error && <p role="alert" className="error-banner">{error}</p>}
  </div></main></div>;
}

function NotFoundPage() {
  const [, setLocation] = useLocation();
  return <div className="app-shell"><main className="page-frame confirm"><div className="confirm-mark"><X size={28} /></div><div className="eyebrow">404 / Not found</div><h2 className="display">That page is off the plan.</h2><p>Return to the pilot workspace and choose a workflow.</p><button className="button button-primary" data-testid="button-go-home" onClick={() => setLocation('/')}>Back to start <ArrowRight size={15} /></button></main></div>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router({ config }: { config: ContractorConfig }) {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={Home} />
    <Route path="/sign-in/*?"><div className="auth-page"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} forceRedirectUrl={`${basePath}/contractor-setup`} /></div></Route>
    <Route path="/sign-up/*?"><div className="auth-page"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} forceRedirectUrl={`${basePath}/contractor-setup`} /></div></Route>
    <Route path="/contractor-setup"><ContractorSettings config={config} /></Route>
    <Route path="/embed-preview"><EmbedPreview config={config} /></Route>
    <Route path="/requests"><RequestHistory config={config} /></Route>
    <Route component={NotFoundPage} />
  </Switch></RoutedErrorBoundary>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkRoutes config={defaults} /></WouterRouter>;
}

function PublicWidgetRoutes() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/widget/benchmark" component={LegacyWidgetRedirect} />
    <Route path="/widget/:id">{(params) => <PublicWidget key={params.id} id={params.id} />}</Route>
    <Route path="/delete-request/:id">{(params) => <HomeownerDelete id={params.id} />}</Route>
    <Route component={NotFoundPage} />
  </Switch></RoutedErrorBoundary>;
}

function ClerkRoutes({ config }: { config: ContractorConfig }) {
  const [, setLocation] = useLocation();
  const [location] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
  if (location.startsWith('/widget/') || location.startsWith('/delete-request/')) return <PublicWidgetRoutes />;
  if (!clerkPubKey) return <main className="public-widget-state"><div className="error-banner" role="alert">Contractor sign-in is not configured on this site. Public homeowner widgets remain available.</div><Link className="button button-primary" href="/">Back to home</Link></main>;
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in for contractor redesign access' } }, signUp: { start: { title: 'Create contractor access', subtitle: 'Protect and track your redesign allowance' } } }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  ><QueryClientProvider client={queryClient}><TooltipProvider><Router config={config} /><Toaster /></TooltipProvider></QueryClientProvider></ClerkProvider>;
}

export default App;