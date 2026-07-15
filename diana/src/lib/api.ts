// Typed API client for Diana (the B2B website). Talks to the SHARED Minerva
// Fastify backend. Two separate identities, two separate tokens:
//   • clinic  — Diana customer (ClinicAccount); sees prices/orders once approved
//   • staff   — agent/supervisor; approves clinics + manages the order queue
// The public catalog needs no token at all. See docs/DIANA_BRIEF.md.

// Empty in dev → all calls are relative and go through the Vite proxy (vite.config.ts),
// keeping them same-origin (no CORS). In prod, VITE_API_URL is baked to the absolute
// API origin at build time (and that origin must be in the API's WEB_ORIGIN allowlist).
export const API_URL: string = import.meta.env.VITE_API_URL ?? '';

// Product photos are served by the backend at /content/product/:sku. Build an
// absolute URL so it works both in dev (Vite on :5175) and prod (static serve).
export const mediaUrl = (p: string): string => `${API_URL}${p}`;

export const formatBaht = (n: number): string =>
  n > 0 ? `฿${n.toLocaleString('th-TH')}` : '—';

// Human-readable order label, e.g. WD-00042. Falls back to the id tail for any row that
// predates the orderNo column (0/undefined — shouldn't happen since the DB default backfills).
export const orderNoLabel = (orderNo: number, id: string): string =>
  orderNo ? `WD-${String(orderNo).padStart(5, '0')}` : `#${id.slice(-8)}`;

// ── shared catalog shapes (mirror api/src/routes/diana.ts DTOs) ─────────────
export interface PublicProduct {
  sku: string;
  nameEn: string;
  nameTh: string;
  note: string;
  promo: string;
  page: number | null;
  photo: string; // path; wrap with mediaUrl() for an <img src>
  // SEO enrichment (ProductEnrichment, joined by sku). Empty string / [] = not enriched.
  brand: string;
  category: string;
  categoryEn: string;
  descriptionTh: string;
  descriptionEn: string;
  specs: string[];
}

export interface Facet { name: string; count: number }
export interface Facets { brands: Facet[]; categories: Facet[] }

export interface CatalogParams {
  q?: string;
  brand?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}
function catalogQs(p: CatalogParams): string {
  const u = new URLSearchParams();
  if (p.q) u.set('q', p.q);
  if (p.brand) u.set('brand', p.brand);
  if (p.category) u.set('category', p.category);
  u.set('page', String(p.page ?? 1));
  u.set('pageSize', String(p.pageSize ?? 24));
  return u.toString();
}

export type Availability = 'in_stock' | 'low' | 'out' | 'unknown';

export interface PricedProduct extends PublicProduct {
  price: number; // baht; 0 = unknown (staff confirm on the order request)
  stock: number | null;
  stockAt: string | null;
  availability: Availability;
}

export interface CatalogPage<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export interface OrderLine {
  id: string;
  sku: string;
  nameSnapshot: string;
  qty: number;
  unitPrice: number;
}

export type OrderStatus = 'submitted' | 'confirmed' | 'invoiced' | 'cancelled';

export interface WebOrder {
  id: string;
  orderNo: number;
  status: OrderStatus;
  note: string;
  taxName: string;
  taxAddress: string;
  taxId: string;
  createdAt: string;
  confirmedAt: string | null;
  invoicedAt: string | null;
  lines: OrderLine[];
}

// ── clinic identity ─────────────────────────────────────────────────────────
export type ClinicStatus = 'pending' | 'approved' | 'rejected';
export interface Clinic {
  id: string;
  email: string;
  clinicName: string;
  status: ClinicStatus;
}

// ── staff identity ──────────────────────────────────────────────────────────
export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const CLINIC_TOKEN = 'diana_clinic_token';
const CLINIC_OBJ = 'diana_clinic';
const STAFF_TOKEN = 'diana_staff_token';
const STAFF_OBJ = 'diana_staff';

function readObj<T>(key: string): T | null {
  const s = localStorage.getItem(key);
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// ── clinic session ──────────────────────────────────────────────────────────
export const getClinicToken = (): string | null => localStorage.getItem(CLINIC_TOKEN);
export const getStoredClinic = (): Clinic | null => readObj<Clinic>(CLINIC_OBJ);
export function setClinicSession(token: string, clinic: Clinic): void {
  localStorage.setItem(CLINIC_TOKEN, token);
  localStorage.setItem(CLINIC_OBJ, JSON.stringify(clinic));
}
export function clearClinicSession(): void {
  localStorage.removeItem(CLINIC_TOKEN);
  localStorage.removeItem(CLINIC_OBJ);
}

// ── staff session ───────────────────────────────────────────────────────────
export const getStaffToken = (): string | null => localStorage.getItem(STAFF_TOKEN);
export const getStoredStaff = (): Agent | null => readObj<Agent>(STAFF_OBJ);
export function setStaffSession(token: string, agent: Agent): void {
  localStorage.setItem(STAFF_TOKEN, token);
  localStorage.setItem(STAFF_OBJ, JSON.stringify(agent));
}
export function clearStaffSession(): void {
  localStorage.removeItem(STAFF_TOKEN);
  localStorage.removeItem(STAFF_OBJ);
}

// Raised when the server rejects an approved-only action because the clinic is
// not (yet) approved — the UI shows a "pending approval" state rather than an error.
export class NotApprovedError extends Error {
  constructor() {
    super('not_approved');
  }
}

async function call<T>(path: string, init: RequestInit | undefined, token: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'not_approved') throw new NotApprovedError();
    throw new Error('forbidden');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const clinicCall = <T>(path: string, init?: RequestInit): Promise<T> => call<T>(path, init, getClinicToken());
const staffCall = <T>(path: string, init?: RequestInit): Promise<T> => call<T>(path, init, getStaffToken());

// ── public catalog (no auth) ────────────────────────────────────────────────
export const getPublicCatalog = (p: CatalogParams) =>
  call<CatalogPage<PublicProduct>>(`/api/diana/catalog?${catalogQs(p)}`, undefined, null);

export const getFacets = () => call<Facets>('/api/diana/facets', undefined, null);

// ── clinic auth ─────────────────────────────────────────────────────────────
export interface RegisterInput {
  email: string;
  password: string;
  clinicName: string;
  contactName: string;
  phone: string;
  pdpaConsent: true;
}
export const registerClinic = (input: RegisterInput) =>
  call<{ ok: boolean; status: ClinicStatus }>('/api/diana/register', {
    method: 'POST',
    body: JSON.stringify(input),
  }, null);

export const loginClinic = (email: string, password: string) =>
  call<{ token: string; clinic: Clinic }>('/api/diana/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, null);

export const getMe = () => clinicCall<{ clinic: Clinic }>('/api/diana/me');

// ── approved-clinic: priced catalog + ordering ──────────────────────────────
export const getPricedCatalog = (p: CatalogParams) =>
  clinicCall<CatalogPage<PricedProduct>>(`/api/diana/priced/catalog?${catalogQs(p)}`);

export interface OrderInput {
  items: { sku: string; qty: number }[];
  note?: string;
  tax?: { name?: string; address?: string; id?: string };
}
export const submitOrder = (input: OrderInput) =>
  clinicCall<{ order: WebOrder }>('/api/diana/orders', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const getMyOrders = () => clinicCall<{ orders: WebOrder[] }>('/api/diana/orders');

// ── staff auth + admin ──────────────────────────────────────────────────────
export const loginStaff = (email: string, password: string) =>
  call<{ token: string; agent: Agent }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, null);

export interface AdminClinic {
  id: string;
  email: string;
  clinicName: string;
  contactName: string;
  phone: string;
  status: ClinicStatus;
  customerCode: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectNote: string;
  pdpaConsentAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}
export const adminListClinics = (status?: ClinicStatus) =>
  staffCall<{ clinics: AdminClinic[] }>(`/api/diana/admin/clinics${status ? `?status=${status}` : ''}`);

export const adminApproveClinic = (id: string, customerCode?: string) =>
  staffCall<{ ok: boolean; status: ClinicStatus }>(`/api/diana/admin/clinics/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(customerCode ? { customerCode } : {}),
  });

export const adminRejectClinic = (id: string, note: string) =>
  staffCall<{ ok: boolean; status: ClinicStatus }>(`/api/diana/admin/clinics/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });

// Supervisor-only: permanently delete a clinic account + all its orders (test cleanup).
export const adminDeleteClinic = (id: string) =>
  staffCall<{ ok: boolean }>(`/api/diana/admin/clinics/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Supervisor-only: reset a clinic's password to a random temp value, returned once so staff
// can read it to the (LINE-verified) caller. No email/reset-link infra exists.
export const adminResetClinicPassword = (id: string) =>
  staffCall<{ ok: boolean; tempPassword: string }>(`/api/diana/admin/clinics/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST',
  });

export interface AdminOrder extends WebOrder {
  clinicAccount: { id: string; clinicName: string; email: string; customerCode: string | null };
}
export const adminListOrders = (status?: OrderStatus) =>
  staffCall<{ orders: AdminOrder[] }>(`/api/diana/admin/orders${status ? `?status=${status}` : ''}`);

export const adminOrderTransition = (id: string, action: 'confirm' | 'invoice' | 'cancel') =>
  staffCall<{ ok: boolean; status: OrderStatus }>(`/api/diana/admin/orders/${id}/${action}`, {
    method: 'POST',
  });

// ── staff admin: catalog enrichment editor ──────────────────────────────────
export interface EnrichRow {
  sku: string;
  nameEn: string;
  nameTh: string;
  price: number;
  photo: string;
  brand: string;
  category: string;
  categoryEn: string;
  descriptionTh: string;
  descriptionEn: string;
  specs: string[];
  source: string | null; // 'derived' | 'manual' | null (not enriched)
}
export interface EnrichInput {
  brand: string;
  category: string;
  categoryEn: string;
  descriptionTh: string;
  descriptionEn: string;
  specs: string[];
}
export const adminListEnrichment = (p: CatalogParams) =>
  staffCall<CatalogPage<EnrichRow>>(`/api/diana/admin/enrichment?${catalogQs(p)}`);

export const adminSaveEnrichment = (sku: string, input: EnrichInput) =>
  staffCall<{ ok: boolean }>(`/api/diana/admin/enrichment/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
