import { useEffect, useState } from 'react';
import './styles.css';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;

export default function App() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | uploading | analyzing | saving | ready | error
  const [error, setError] = useState(null);
  const [pastReceipts, setPastReceipts] = useState([]);
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    refreshPastReceipts().then(setPastReceipts).catch(() => {});
  }, []);

  async function handleSelectPast(receiptId) {
    setSelectedId(receiptId);
    if (!receiptId) {
      setResult(null);
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/receipts/${encodeURIComponent(receiptId)}`);
      if (!res.ok) throw new Error(`Lookup failed (HTTP ${res.status})`);
      const body = await res.json();
      if (body.status !== 'ready') throw new Error('That receipt is still being analyzed.');
      setResult(body);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setResult(null);
    setStatus('uploading');

    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await fetch('/api/process-receipt', {
        method: 'POST',
        body: formData,
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload failed (HTTP ${uploadRes.status}): ${await uploadRes.text()}`);
      }
      const { receipt_id } = await uploadRes.json();

      setStatus('analyzing');
      const analysis = await pollReceipt(receipt_id);

      // Hold the "Save to DynamoDB" step visible briefly so users see all three
      // pipeline stages before results render.
      setStatus('saving');
      await wait(10_000);
      setResult(analysis);
      setSelectedId(analysis.receipt_id ?? '');
      setStatus('ready');
      refreshPastReceipts().then(setPastReceipts).catch(() => {});
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Receipt Health Analyzer</h1>
        <p>Upload a grocery receipt to see a nutrition breakdown and personalized swap suggestions.</p>
      </header>

      <section className="card">
        <form className="upload-form" onSubmit={handleSubmit}>
          <input
            className="file-input"
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={status === 'uploading' || status === 'analyzing' || status === 'saving'}
          />
          <button
            type="submit"
            className="btn"
            disabled={!file || status === 'uploading' || status === 'analyzing' || status === 'saving'}
          >
            {status === 'uploading' || status === 'analyzing' || status === 'saving' ? 'Processing…' : 'Analyze receipt'}
          </button>
        </form>

        {status !== 'idle' && <PipelineSteps status={status} />}

        {pastReceipts.length > 0 && (
          <div className="past-receipts">
            <label htmlFor="past-select">View a previous analysis</label>
            <select
              id="past-select"
              value={selectedId}
              onChange={(e) => handleSelectPast(e.target.value)}
            >
              <option value="">Select a receipt…</option>
              {pastReceipts.map((r) => (
                <option key={r.receipt_id} value={r.receipt_id}>
                  {formatReceiptLabel(r)}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="error" style={{ marginTop: '1rem' }}>
            <span>{error}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setError(null);
                setStatus('idle');
              }}
            >
              Try again
            </button>
          </div>
        )}
      </section>

      {result && <Results data={result} />}
    </main>
  );
}

function Results({ data }) {
  const score = Number(data.health_score ?? 0);
  const healthy = data.healthy_items ?? [];
  const unhealthy = data.unhealthy_items ?? [];
  const nonFood = data.non_food_items ?? [];
  const unknown = data.unknown_items ?? [];
  const swaps = dedupeSwaps(data.food_swaps ?? []);

  return (
    <>
      <section className="card">
        <div className="score-row">
          <ScoreRing value={score} />
          <div className="score-summary">
            <h2>Your basket scored {score} / 100</h2>
            <p>{data.analysis}</p>
          </div>
        </div>
      </section>

      <section className="card">
        <p className="section-title">Item breakdown</p>
        <div className="items-grid">
          <ItemGroup title="Healthy" tone="good" items={healthy} />
          <ItemGroup title="Unhealthy" tone="bad" items={unhealthy} />
          <ItemGroup title="Non-food" tone="neutral" items={nonFood} />
          <ItemGroup title="Uncategorized" tone="info" items={unknown} />
        </div>
        {unknown.length > 0 && (
          <p className="hint">
            Uncategorized items weren't matched against the healthy / unhealthy / non-food keyword sets and didn't count toward your score. Add them to the keyword lists in <code>lambda_function.py</code> to improve future classification.
          </p>
        )}
      </section>

      {swaps.length > 0 && (
        <section className="card">
          <p className="section-title">Suggested swaps</p>
          <div className="swaps">
            {swaps.map((swap, i) => (
              <div className="swap" key={i}>
                <span className="from">{swap.item}</span>
                <span className="arrow">→</span>
                <span className="to">{swap.suggestion}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.uploaded_at && (
        <p className="meta">Analyzed {new Date(data.uploaded_at).toLocaleString()}</p>
      )}
    </>
  );
}

function ScoreRing({ value }) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const color = clamped >= 70 ? 'var(--good)' : clamped >= 40 ? 'var(--warn)' : 'var(--bad)';

  return (
    <div className="score-ring">
      <svg width="128" height="128" viewBox="0 0 128 128">
        <circle className="track" cx="64" cy="64" r={radius} strokeWidth="10" fill="none" />
        <circle
          className="progress"
          cx="64"
          cy="64"
          r={radius}
          strokeWidth="10"
          fill="none"
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="label">
        <span className="value" style={{ color }}>{clamped}</span>
        <span className="caption">Health score</span>
      </div>
    </div>
  );
}

function ItemGroup({ title, tone, items }) {
  const grouped = groupItems(items);
  return (
    <div className={`item-group ${tone}`}>
      <h3>
        {title}
        <span className="count-pill">{items.length}</span>
      </h3>
      {grouped.length === 0 ? (
        <p className="empty">None detected.</p>
      ) : (
        <ul>
          {grouped.map(({ label, count }) => (
            <li key={label}>
              <span className="item-label">{label}</span>
              {count > 1 && <span className="item-qty">×{count}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupItems(items) {
  const counts = new Map();
  for (const item of items) {
    const label = (item ?? '').trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => ({ label, count })).sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label)
  );
}

function PipelineSteps({ status }) {
  const steps = [
    {
      title: 'Upload to Amazon S3',
      detail: 'Storing the receipt image in the bucket.',
      state: stepState(status, 0),
    },
    {
      title: 'Analyze with AWS Lambda',
      detail: 'Running Textract OCR and classifying items.',
      state: stepState(status, 1),
    },
    {
      title: 'Save to DynamoDB',
      detail: 'Writing the analysis to the results table.',
      state: stepState(status, 2),
    },
  ];

  return (
    <ol className="pipeline">
      {steps.map((step, i) => (
        <li key={i} className={`pipeline-step ${step.state}`}>
          <span className="pipeline-marker" aria-hidden="true">
            {step.state === 'done' ? (
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : step.state === 'active' ? (
              <span className="pipeline-spinner" />
            ) : (
              <span className="pipeline-dot" />
            )}
          </span>
          <div className="pipeline-text">
            <div className="pipeline-title">{step.title}</div>
            <div className="pipeline-detail">{step.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function stepState(status, index) {
  // Step 0 = S3 upload, 1 = Lambda processing, 2 = DynamoDB write.
  // During 'analyzing', the Lambda+DDB write are happening server-side; we mark
  // the Lambda step active and DDB pending. When 'ready', everything has happened.
  if (status === 'error') {
    if (index === 0) return 'done';
    return 'pending';
  }
  if (status === 'ready') return 'done';
  if (status === 'saving') {
    if (index === 0 || index === 1) return 'done';
    return 'active';
  }
  if (status === 'analyzing') {
    if (index === 0) return 'done';
    if (index === 1) return 'active';
    return 'pending';
  }
  if (status === 'uploading') {
    if (index === 0) return 'active';
    return 'pending';
  }
  return 'pending';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshPastReceipts() {
  const res = await fetch('/api/receipts');
  if (!res.ok) throw new Error(`List failed (HTTP ${res.status})`);
  const body = await res.json();
  return body.items ?? [];
}

function formatReceiptLabel(r) {
  const parts = [extractReceiptName(r.receipt_id)];
  if (r.uploaded_at) {
    const d = new Date(r.uploaded_at);
    if (!isNaN(d)) parts.push(d.toLocaleString());
  }
  if (r.health_score != null) parts.push(`Score ${r.health_score}`);
  return parts.join(' • ');
}

function extractReceiptName(receiptId) {
  if (!receiptId) return 'Unknown';
  // S3 key pattern: receipts/<timestamp>-<filename> → receipts_<timestamp>-<filename>
  const match = receiptId.match(/^receipts_\d+-(.+)$/);
  return match ? match[1] : receiptId;
}

function dedupeSwaps(swaps) {
  const seen = new Set();
  const unique = [];
  for (const swap of swaps) {
    const key = swap?.suggestion ?? '';
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(swap);
    }
  }
  return unique;
}

async function pollReceipt(receiptId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`/api/receipts/${encodeURIComponent(receiptId)}`);
    if (!res.ok) {
      throw new Error(`Lookup failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    if (body.status === 'ready') return body;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Analysis timed out. The receipt may still be processing — try refreshing in a moment.');
}
