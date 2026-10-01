import { BOX_SIZE, formatCents, MAX_BARS_PER_ORDER } from '../../shared/pricing';
import type { OrderConfirmation, PublicProduct } from '../../shared/types';
import { validateCheckoutDetails, type CheckoutDetails } from '../../shared/validation';
import { ApiRequestError, apiJson } from '../lib/client/api';
import { byId, h } from '../lib/client/dom';

type StoreState = 'open' | 'closed' | 'coming_soon';

const CART_STORAGE_KEY = 'wfc-cart';
const TURNSTILE_SITE_KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || '1x00000000000000000000AA';
const DETAIL_FIELDS: Array<keyof CheckoutDetails> = [
  'customerName',
  'phone',
  'street',
  'city',
  'state',
  'zip',
  'deliveryInstructions',
];

// Accent colors taken from each flavor's wrapper in the product photo.
const SWATCHES: Record<string, string> = {
  'milk-chocolate': 'bg-[#5bb8e6]',
  caramel: 'bg-[#f7941d]',
  crisp: 'bg-[#f0e04a]',
  wafer: 'bg-[#f05a6e]',
  almond: 'bg-[#f2702c]',
  pretzel: 'bg-[#b48fd8]',
};

let products: PublicProduct[] = [];
let storeState: StoreState = 'closed';
const cart = new Map<number, number>();
let submissionId = crypto.randomUUID();
let turnstileToken = '';
let turnstileWidgetId: string | undefined;
let submitting = false;

const elements = {
  loading: byId('store-loading'),
  error: byId('store-error'),
  notice: byId('store-notice'),
  noticeTitle: byId('store-notice-title'),
  noticeBody: byId('store-notice-body'),
  store: byId('store'),
  productList: byId<HTMLUListElement>('product-list'),
  template: byId<HTMLTemplateElement>('product-template'),
  summaryEmpty: byId('summary-empty'),
  summaryLines: byId<HTMLUListElement>('summary-lines'),
  summaryTotals: byId('summary-totals'),
  summaryBars: byId('summary-bars'),
  summaryTotal: byId('summary-total'),
  summaryBoxHint: byId('summary-box-hint'),
  form: byId<HTMLFormElement>('checkout-form'),
  formError: byId('checkout-error'),
  submit: byId<HTMLButtonElement>('checkout-submit'),
  turnstile: byId('turnstile'),
  mobileBar: byId('mobile-bar'),
  mobileBars: byId('mobile-bars'),
  mobileTotal: byId('mobile-total'),
  confirmation: byId('confirmation'),
};

function barsLabel(count: number): string {
  return `${count} ${count === 1 ? 'bar' : 'bars'}`;
}

function loadSavedCart(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    for (const [id, quantity] of Object.entries(saved)) {
      if (Number.isSafeInteger(quantity) && (quantity as number) > 0)
        cart.set(Number(id), quantity as number);
    }
  } catch {
    // Storage unavailable (private mode, blocked); the cart simply starts empty.
  }
}

function saveCart(): void {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(Object.fromEntries(cart)));
  } catch {
    // Ignore; persistence is only a convenience.
  }
}

function totalBars(): number {
  return [...cart.values()].reduce((sum, quantity) => sum + quantity, 0);
}

function maxFor(product: PublicProduct): number {
  const otherBars = totalBars() - (cart.get(product.id) ?? 0);
  return Math.max(0, Math.min(product.available, MAX_BARS_PER_ORDER - otherBars));
}

function setQuantity(product: PublicProduct, requested: number): void {
  const quantity = Math.max(0, Math.min(Math.floor(requested) || 0, maxFor(product)));
  if (quantity > 0) cart.set(product.id, quantity);
  else cart.delete(product.id);
  saveCart();
  render();
}

function renderProducts(): void {
  const ordering = storeState === 'open';
  elements.productList.replaceChildren(
    ...products.map((product) => {
      const fragment = elements.template.content.cloneNode(true) as DocumentFragment;
      const card = fragment.querySelector<HTMLLIElement>('.product-card')!;
      card.dataset.productId = String(product.id);
      card.querySelector('.product-name')!.textContent = product.name;
      card.querySelector('.product-description')!.textContent = product.description;
      card.querySelector('.product-price')!.textContent = `${formatCents(product.priceCents)} each`;
      card.querySelector('.product-swatch')!.classList.add(SWATCHES[product.slug] ?? 'bg-cocoa');

      const badge = card.querySelector<HTMLElement>('.product-badge')!;
      // Before ordering opens, show the lineup only; stock badges would read as "sold out".
      if (ordering && product.availability === 'sold_out') {
        badge.textContent = 'Sold Out';
        badge.classList.add('bg-cocoa/10', 'text-cocoa-soft');
        badge.hidden = false;
        card.classList.add('opacity-60');
      } else if (ordering && product.availability === 'going_fast') {
        badge.textContent = '🔥 Going Fast';
        badge.classList.add('bg-honey', 'text-cocoa-ink');
        badge.hidden = false;
      }

      const stepper = card.querySelector<HTMLElement>('.product-stepper')!;
      const input = card.querySelector<HTMLInputElement>('.product-quantity')!;
      const minus = card.querySelector<HTMLButtonElement>('.product-minus')!;
      const plus = card.querySelector<HTMLButtonElement>('.product-plus')!;
      input.id = `quantity-${product.id}`;
      input.setAttribute('aria-label', `${product.name} quantity`);
      minus.setAttribute('aria-label', `Remove one ${product.name}`);
      plus.setAttribute('aria-label', `Add one ${product.name}`);
      if (!ordering || product.availability === 'sold_out') {
        stepper.hidden = true;
      }
      minus.addEventListener('click', () => setQuantity(product, (cart.get(product.id) ?? 0) - 1));
      plus.addEventListener('click', () => setQuantity(product, (cart.get(product.id) ?? 0) + 1));
      input.addEventListener('change', () => setQuantity(product, Number(input.value)));
      input.addEventListener('focus', () => input.select());
      return fragment;
    }),
  );
}

function render(): void {
  const bars = totalBars();
  const totalCents = products.reduce(
    (sum, product) => sum + product.priceCents * (cart.get(product.id) ?? 0),
    0,
  );

  for (const product of products) {
    const card = elements.productList.querySelector<HTMLElement>(
      `[data-product-id="${product.id}"]`,
    );
    if (!card) continue;
    const quantity = cart.get(product.id) ?? 0;
    const max = maxFor(product);
    card.querySelector<HTMLInputElement>('.product-quantity')!.value = String(quantity);
    card.querySelector<HTMLInputElement>('.product-quantity')!.max = String(max);
    card.querySelector<HTMLButtonElement>('.product-minus')!.disabled = quantity === 0;
    card.querySelector<HTMLButtonElement>('.product-plus')!.disabled = quantity >= max;
    card.classList.toggle('ring-2', quantity > 0);
    card.classList.toggle('ring-berry', quantity > 0);
  }

  elements.summaryLines.replaceChildren(
    ...products
      .filter((product) => cart.has(product.id))
      .map((product) => {
        const quantity = cart.get(product.id)!;
        return h('li', { className: 'flex items-baseline justify-between gap-3 py-2' }, [
          h('span', {}, [
            h('span', { className: 'font-bold text-cocoa', text: product.name }),
            h('span', { className: 'text-cocoa-soft', text: ` × ${quantity}` }),
          ]),
          h('span', {
            className: 'tabular-nums',
            text: formatCents(product.priceCents * quantity),
          }),
        ]);
      }),
  );

  const hasItems = bars > 0;
  elements.summaryEmpty.hidden = hasItems;
  elements.summaryTotals.hidden = !hasItems;
  elements.form.hidden = !hasItems || storeState !== 'open';
  elements.mobileBar.hidden = !hasItems || storeState !== 'open' || !elements.confirmation.hidden;
  elements.summaryBars.textContent = String(bars);
  elements.summaryTotal.textContent = formatCents(totalCents);
  elements.mobileBars.textContent = barsLabel(bars);
  elements.mobileTotal.textContent = formatCents(totalCents);
  elements.submit.textContent = hasItems
    ? `Place order · ${formatCents(totalCents)}`
    : 'Place order';

  const fullBoxes = Math.floor(bars / BOX_SIZE);
  const remainder = bars % BOX_SIZE;
  elements.summaryBoxHint.textContent =
    fullBoxes > 0 && remainder === 0
      ? `That’s ${fullBoxes === 1 ? 'a full box' : `${fullBoxes} full boxes`} of ${BOX_SIZE}!`
      : `${BOX_SIZE - remainder} more ${BOX_SIZE - remainder === 1 ? 'bar' : 'bars'} fills ${fullBoxes > 0 ? 'another' : 'a'} box of ${BOX_SIZE}.`;

  if (hasItems && storeState === 'open') ensureTurnstile();
}

function showNotice(title: string, body: string): void {
  elements.noticeTitle.textContent = title;
  elements.noticeBody.textContent = body;
  elements.notice.hidden = false;
}

async function loadStore(): Promise<void> {
  elements.loading.hidden = false;
  elements.error.hidden = true;
  try {
    const data = await apiJson<{ state: StoreState; products: PublicProduct[] }>('/api/storefront');
    products = data.products;
    storeState = data.state;
  } catch {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    return;
  }

  // Drop anything in a saved cart that is no longer orderable.
  for (const product of products) {
    const quantity = cart.get(product.id);
    if (quantity !== undefined && (storeState !== 'open' || quantity > product.available)) {
      if (storeState === 'open' && product.available > 0) cart.set(product.id, product.available);
      else cart.delete(product.id);
    }
  }
  for (const id of cart.keys()) {
    if (!products.some((product) => product.id === id)) cart.delete(id);
  }

  elements.notice.hidden = true;
  if (storeState === 'coming_soon') {
    showNotice(
      'Ordering opens soon',
      'We’re getting our chocolate ready. Check back shortly to place your order!',
    );
  } else if (storeState === 'closed') {
    showNotice('Ordering is closed right now', 'Thanks for your interest! Please check back soon.');
  }

  elements.loading.hidden = true;
  const ordering = storeState === 'open';
  elements.store.hidden = false;
  elements.store.classList.toggle('lg:grid-cols-[minmax(0,1fr)_24rem]', ordering);
  elements.productList.classList.toggle('lg:grid-cols-3', !ordering);
  byId('checkout').hidden = !ordering;
  byId('flavors-title').textContent = ordering ? 'Choose your flavors' : 'Our flavors';
  renderProducts();
  render();
}

function ensureTurnstile(): void {
  if (turnstileWidgetId !== undefined || document.getElementById('turnstile-script')) {
    return;
  }
  const script = document.createElement('script');
  script.id = 'turnstile-script';
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.addEventListener('load', () => {
    turnstileWidgetId = window.turnstile?.render(elements.turnstile, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'light',
      size: 'flexible',
      callback: (token) => {
        turnstileToken = token;
      },
      'expired-callback': () => {
        turnstileToken = '';
      },
      'error-callback': () => {
        turnstileToken = '';
      },
    });
  });
  document.head.append(script);
}

function resetTurnstile(): void {
  turnstileToken = '';
  if (turnstileWidgetId !== undefined) window.turnstile?.reset(turnstileWidgetId);
}

function readDetails(): Record<string, string> {
  const data = new FormData(elements.form);
  return Object.fromEntries(DETAIL_FIELDS.map((field) => [field, String(data.get(field) ?? '')]));
}

function showFieldErrors(errors: Partial<Record<string, string>>): void {
  let firstInvalid: HTMLElement | null = null;
  for (const field of DETAIL_FIELDS) {
    const input = byId<HTMLInputElement>(field);
    const message = byId(`${field}-error`);
    const error = errors[field];
    message.textContent = error ?? '';
    message.hidden = !error;
    if (error) {
      input.setAttribute('aria-invalid', 'true');
      firstInvalid ??= input;
    } else {
      input.removeAttribute('aria-invalid');
    }
  }
  firstInvalid?.focus();
}

function showFormError(message: string): void {
  elements.formError.textContent = message;
  elements.formError.hidden = !message;
}

function setSubmitting(value: boolean): void {
  submitting = value;
  elements.submit.disabled = value;
  elements.form.setAttribute('aria-busy', String(value));
  if (value) elements.submit.textContent = 'Placing your order…';
  else render();
}

function showConfirmation(order: OrderConfirmation): void {
  byId('confirmation-number').textContent = order.orderNumber;
  byId('confirmation-bars').textContent = barsLabel(order.totalBars);
  byId('confirmation-total').textContent = formatCents(order.totalCents);
  byId('confirmation-lines').replaceChildren(
    ...order.items.map((item) =>
      h('li', { className: 'flex items-baseline justify-between gap-3 py-2' }, [
        h('span', {}, [
          h('span', { className: 'font-bold text-cocoa', text: item.productName }),
          h('span', { className: 'text-cocoa-soft', text: ` × ${item.quantity}` }),
        ]),
        h('span', { className: 'tabular-nums', text: formatCents(item.lineTotalCents) }),
      ]),
    ),
  );
  elements.store.hidden = true;
  elements.notice.hidden = true;
  elements.mobileBar.hidden = true;
  elements.confirmation.hidden = false;
  elements.confirmation.focus();
  window.scrollTo({ top: 0 });
}

async function submitOrder(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (submitting) return;
  showFormError('');

  const details = validateCheckoutDetails(readDetails());
  if (!details.ok) {
    showFieldErrors(details.errors);
    return;
  }
  showFieldErrors({});
  if (totalBars() === 0) {
    showFormError('Please choose at least one bar.');
    return;
  }
  if (!turnstileToken) {
    showFormError('Please complete the “verify you are human” check above.');
    return;
  }

  setSubmitting(true);
  try {
    const { order } = await apiJson<{ order: OrderConfirmation }>('/api/orders', {
      body: {
        submissionId,
        turnstileToken,
        details: details.value,
        items: [...cart].map(([productId, quantity]) => ({ productId, quantity })),
      },
    });
    cart.clear();
    saveCart();
    elements.form.reset();
    submissionId = crypto.randomUUID();
    submitting = false;
    elements.submit.disabled = false;
    showConfirmation(order);
    resetTurnstile();
  } catch (error) {
    setSubmitting(false);
    resetTurnstile();
    if (!(error instanceof ApiRequestError)) {
      showFormError('Something went wrong. Please try again.');
      return;
    }
    // On network errors keep the same submissionId, so a retry cannot create a duplicate order.
    if (error.status !== 0) submissionId = crypto.randomUUID();
    if (error.code === 'validation_failed' && error.details && typeof error.details === 'object') {
      showFieldErrors(error.details as Record<string, string>);
    }
    showFormError(error.message);
    if (
      error.code === 'insufficient_stock' ||
      error.code === 'ordering_closed' ||
      error.code === 'order_conflict'
    ) {
      await loadStore();
    }
  }
}

loadSavedCart();
elements.form.addEventListener('submit', (event) => void submitOrder(event));
byId('store-retry').addEventListener('click', () => void loadStore());
byId('new-order').addEventListener('click', () => {
  elements.confirmation.hidden = true;
  void loadStore();
});
void loadStore();
