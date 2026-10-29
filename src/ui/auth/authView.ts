/**
 * Sign-in screens shown before the app when cloud accounts are enabled:
 * sign in, create account, forgot password, and "choose a new password" after a reset link.
 */
import { AuthError, type AuthClient, type AuthSession } from '../../core/sync/authClient.ts';
import { languageSwitch } from '../components/languageSwitch.ts';
import { h, replaceChildren } from '../dom.ts';
import { dir, getLocale, setLocale, t, type Locale } from '../i18n/index.ts';

export function authErrorText(e: unknown): string {
  if (e instanceof AuthError) return e.code === 'unknown' ? t('auth.e.unknown', { detail: e.message }) : t(`auth.e.${e.code}`);
  return t('auth.e.unknown', { detail: e instanceof Error ? e.message : String(e) });
}

export function applyDocumentLanguage(l: Locale): void {
  setLocale(l);
  document.documentElement.lang = l;
  document.documentElement.dir = dir(l);
}

type Mode = 'signIn' | 'signUp' | 'forgot';
export interface AuthMessage {
  readonly kind: 'error' | 'info';
  readonly text: () => string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function page(onLanguage: (l: Locale) => void, rerender: () => void, ...card: Parameters<typeof h>[2][]): HTMLElement {
  return h(
    'div',
    { class: 'auth-page' },
    h(
      'header',
      { class: 'auth-top' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'ح'), h('span', { class: 'brand-name' }, t('app.name'), h('span', { class: 'brand-sub' }, t('app.tagline')))),
      languageSwitch(getLocale(), (l) => {
        applyDocumentLanguage(l);
        onLanguage(l);
        rerender();
      }),
    ),
    h('main', { id: 'main', class: 'auth-card panel', tabindex: '-1' }, ...card),
    h('p', { class: 'auth-foot muted' }, t('auth.privacy')),
  );
}

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

function passwordInput(id: string, autocomplete: string): HTMLInputElement {
  return h('input', { id, type: 'password', autocomplete, required: true, minlength: '8', dir: 'ltr', class: 'ltr' });
}

function showToggle(...inputs: HTMLInputElement[]): HTMLElement {
  return h('label', { class: 'choice' }, h('input', { type: 'checkbox', onchange: (e: Event) => { for (const i of inputs) i.type = (e.target as HTMLInputElement).checked ? 'text' : 'password'; } }), h('span', null, t('auth.showPassword')));
}

/** Resolves with a session once the user has signed in (or signed up without email confirmation). */
export function showAuthScreen(root: HTMLElement, opts: { client: AuthClient; redirectTo: string; message?: AuthMessage | null; onLanguage: (l: Locale) => void }): Promise<AuthSession> {
  return new Promise((resolve) => {
    let mode: Mode = 'signIn';
    let message: AuthMessage | null = opts.message ?? null;
    let email = '';

    const render = () => {
      const emailIn = h('input', { id: 'auth-email', type: 'email', autocomplete: 'email', required: true, value: email, dir: 'ltr', class: 'ltr', inputmode: 'email', oninput: () => { email = emailIn.value; } });
      const pw = passwordInput('auth-password', mode === 'signUp' ? 'new-password' : 'current-password');
      const pw2 = passwordInput('auth-password2', 'new-password');
      const status = h('div', { role: 'alert', 'aria-live': 'assertive' });
      const showMessage = (m: AuthMessage | null) => {
        message = m;
        replaceChildren(status, m ? h('div', { class: `notice ${m.kind === 'error' ? 'error' : 'info'}` }, m.text()) : null);
      };
      showMessage(message);
      const submit = h('button', { type: 'submit', class: 'primary big', 'data-key': 'auth-submit' }, mode === 'signIn' ? t('auth.signIn') : mode === 'signUp' ? t('auth.signUp') : t('auth.sendReset'));
      const go = (m: Mode) => () => { mode = m; message = null; render(); };

      const form = h(
        'form',
        {
          class: 'stack', novalidate: true,
          onsubmit: async (e: Event) => {
            e.preventDefault();
            email = emailIn.value.trim();
            if (!EMAIL_RE.test(email)) { showMessage({ kind: 'error', text: () => t('auth.vEmail') }); emailIn.focus(); return; }
            if (mode !== 'forgot' && pw.value.length < 8) { showMessage({ kind: 'error', text: () => t('auth.vPassword') }); pw.focus(); return; }
            if (mode === 'signUp' && pw.value !== pw2.value) { showMessage({ kind: 'error', text: () => t('auth.vMatch') }); pw2.focus(); return; }
            submit.disabled = true;
            submit.setAttribute('aria-busy', 'true');
            submit.textContent = t('auth.working');
            try {
              if (mode === 'signIn') {
                resolve(await opts.client.signIn(email, pw.value));
                return;
              }
              if (mode === 'signUp') {
                const s = await opts.client.signUp(email, pw.value, opts.redirectTo);
                if (s) { resolve(s); return; }
                const sentTo = email;
                mode = 'signIn';
                message = { kind: 'info', text: () => t('auth.checkEmail', { email: sentTo }) };
                render();
                return;
              }
              await opts.client.recover(email, opts.redirectTo);
              const sentTo = email;
              mode = 'signIn';
              message = { kind: 'info', text: () => t('auth.resetSent', { email: sentTo }) };
              render();
            } catch (err) {
              const text = authErrorText(err);
              submit.disabled = false;
              submit.removeAttribute('aria-busy');
              submit.textContent = mode === 'signIn' ? t('auth.signIn') : mode === 'signUp' ? t('auth.signUp') : t('auth.sendReset');
              showMessage({ kind: 'error', text: () => text });
            }
          },
        },
        field(t('auth.email'), emailIn),
        mode !== 'forgot' ? field(t('auth.password'), pw, mode === 'signUp' ? t('auth.passwordHint') : undefined) : null,
        mode === 'signUp' ? field(t('auth.confirmPassword'), pw2) : null,
        mode !== 'forgot' ? showToggle(pw, pw2) : null,
        submit,
      );

      replaceChildren(
        root,
        page(opts.onLanguage, render,
          h('h1', null, mode === 'signIn' ? t('auth.signInTitle') : mode === 'signUp' ? t('auth.signUpTitle') : t('auth.forgotTitle')),
          h('p', { class: 'muted' }, t('auth.intro')),
          status,
          form,
          h(
            'div',
            { class: 'auth-links' },
            mode === 'signIn' ? [h('button', { type: 'button', class: 'quiet', 'data-key': 'auth-to-signup', onclick: go('signUp') }, t('auth.toSignUp')), h('button', { type: 'button', class: 'quiet', 'data-key': 'auth-to-forgot', onclick: go('forgot') }, t('auth.toForgot'))] : null,
            mode !== 'signIn' ? h('button', { type: 'button', class: 'quiet', 'data-key': 'auth-to-signin', onclick: go('signIn') }, mode === 'signUp' ? t('auth.toSignIn') : t('auth.backToSignIn')) : null,
          ),
        ),
      );
      document.title = t('app.titleSuffix', { page: mode === 'signUp' ? t('auth.signUpTitle') : t('auth.signInTitle') });
      (email ? (mode === 'forgot' ? emailIn : pw) : emailIn).focus({ preventScroll: true });
    };
    render();
  });
}

/** After a password-reset link: asks for the new password, then resolves. */
export function showNewPasswordScreen(root: HTMLElement, opts: { client: AuthClient; session: AuthSession; onLanguage: (l: Locale) => void }): Promise<void> {
  return new Promise((resolve) => {
    const render = () => {
      const pw = passwordInput('auth-new', 'new-password');
      const pw2 = passwordInput('auth-new2', 'new-password');
      const status = h('div', { role: 'alert', 'aria-live': 'assertive' });
      const fail = (text: string) => replaceChildren(status, h('div', { class: 'notice error' }, text));
      const submit = h('button', { type: 'submit', class: 'primary big' }, t('auth.savePassword'));
      replaceChildren(
        root,
        page(opts.onLanguage, render,
          h('h1', null, t('auth.newPasswordTitle')),
          h('p', { class: 'muted', dir: 'ltr', style: { 'text-align': 'start' } }, opts.session.user.email),
          status,
          h(
            'form',
            {
              class: 'stack', novalidate: true,
              onsubmit: async (e: Event) => {
                e.preventDefault();
                if (pw.value.length < 8) return fail(t('auth.vPassword'));
                if (pw.value !== pw2.value) return fail(t('auth.vMatch'));
                submit.disabled = true;
                try {
                  await opts.client.updatePassword(opts.session.accessToken, pw.value);
                  resolve();
                } catch (err) {
                  submit.disabled = false;
                  fail(authErrorText(err));
                }
              },
            },
            field(t('auth.newPassword'), pw, t('auth.passwordHint')),
            field(t('auth.confirmPassword'), pw2),
            showToggle(pw, pw2),
            submit,
          ),
        ),
      );
      pw.focus({ preventScroll: true });
    };
    render();
  });
}
