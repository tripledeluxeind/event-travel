// Shared sign-in UI (Google + email/password) for landing.html and
// city.html. Dynamically imports firebase-sync.js (an ES module - dynamic
// `import()` works from a plain classic script, no `type="module"` tag
// needed) so a missing/unconfigured/broken Firebase setup never breaks the
// rest of the app: if the import or firebase-sync's own init() throws,
// this file just logs a warning and the sign-in UI never renders. Nothing
// else on the page depends on this module existing.
//
// Exposes window.EventTravelSync (only once Firebase has actually loaded)
// for app.js to push local changes to Firestore - see pushCity/pushTickets
// below. Every call site in app.js uses `window.EventTravelSync?.foo?.()`,
// so a page with no signed-in user, or no Firebase at all, behaves exactly
// as before this feature existed.
(function () {
  let sync = null;
  let currentUser = null;
  let popoverEl = null;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function getLocalState() {
    let tickets = [];
    try {
      tickets = JSON.parse(localStorage.getItem("ticketedEvents") || "[]");
    } catch {
      tickets = [];
    }
    return {
      defaultCity: localStorage.getItem("cityKey") || null,
      defaultCityUpdatedAt: Number(localStorage.getItem("cityKeyUpdatedAt") || 0) || null,
      ticketedEvents: Array.isArray(tickets) ? tickets : [],
    };
  }

  function applyMergedState(merged) {
    if (merged.defaultCity) {
      localStorage.setItem("cityKey", merged.defaultCity);
      if (merged.defaultCityUpdatedAt) {
        localStorage.setItem("cityKeyUpdatedAt", String(merged.defaultCityUpdatedAt));
      }
    }
    localStorage.setItem("ticketedEvents", JSON.stringify(merged.ticketedEvents || []));
  }

  // Union ticketedEvents by `key`; last-write-wins on defaultCity via the
  // explicit defaultCityUpdatedAt timestamp (not Firestore's own
  // updatedAt, which is just bookkeeping - see firebase-sync.js).
  // Accepted limitation: no tombstones, so a ticket removed on one device
  // while another is offline (and still has it locally) can resurrect
  // once that device reconnects - documented in HANDOFF.md, not solved
  // here.
  function mergeStates(local, cloud) {
    if (!cloud) return local;
    const byKey = new Map();
    [...(cloud.ticketedEvents || []), ...(local.ticketedEvents || [])].forEach(t => {
      if (t && t.key) byKey.set(t.key, t);
    });
    const localTs = local.defaultCityUpdatedAt || 0;
    const cloudTs = cloud.defaultCityUpdatedAt || 0;
    return {
      defaultCity: cloudTs >= localTs ? (cloud.defaultCity || local.defaultCity) : local.defaultCity,
      defaultCityUpdatedAt: Math.max(localTs, cloudTs) || null,
      ticketedEvents: [...byKey.values()],
    };
  }

  const authListeners = [];

  function notifyAuthListeners() {
    const signedIn = !!currentUser;
    authListeners.forEach(cb => {
      try {
        cb(signedIn);
      } catch (e) {
        console.error(e);
      }
    });
  }

  window.EventTravelSync = {
    isSignedIn: () => !!currentUser,
    // Fires immediately with the current state when registered, then again
    // on every sign-in/sign-out - app.js uses this to show/hide the
    // tickets feature live, not just after a reload.
    onAuthStateChange(cb) {
      authListeners.push(cb);
      cb(!!currentUser);
    },
    pushCity(key, updatedAt) {
      if (!sync || !currentUser) return;
      sync.pushUserDoc(currentUser.uid, { defaultCity: key, defaultCityUpdatedAt: updatedAt }).catch(() => {});
    },
    pushTickets(list) {
      if (!sync || !currentUser) return;
      sync.pushUserDoc(currentUser.uid, { ticketedEvents: list }).catch(() => {});
    },
  };

  // Reconciles local state against the cloud on every sign-in (including
  // the session Firebase restores automatically on a fresh page load).
  // Reloads the page exactly once if the merge actually changed anything
  // locally (new tickets or a different city pulled in from another
  // device) so the already-rendered page picks it up - a routine revisit
  // where cloud and local already agree never reloads.
  async function reconcile(user) {
    const local = getLocalState();
    const before = JSON.stringify(local);
    let merged = local;
    try {
      const cloud = await sync.pullUserDoc(user.uid);
      merged = mergeStates(local, cloud);
    } catch {
      // Offline, or no doc yet - fall back to local; pushUserDoc below
      // seeds the cloud doc for a first-time sign-in.
    }
    applyMergedState(merged);
    sync.pushUserDoc(user.uid, merged).catch(() => {});
    if (JSON.stringify(getLocalState()) !== before) {
      location.reload();
    }
  }

  function renderSignedOut() {
    const slot = document.getElementById("auth-slot");
    if (!slot) return;
    slot.innerHTML = `<button type="button" class="auth-btn" id="auth-open-btn">Sign In</button>`;
    document.getElementById("auth-open-btn").addEventListener("click", openPopover);
  }

  // Shows who's signed in without the full address - e.g.
  // "michaeljbowen2@gmail.com" -> "mi***@gmail.com". A fixed-length mask
  // (not based on the real local-part length) so the header doesn't leak
  // how long the address is either.
  function maskEmail(email) {
    const at = email.indexOf("@");
    if (at <= 0) return email;
    const visible = email.slice(0, Math.min(2, at));
    return `${visible}***${email.slice(at)}`;
  }

  function renderSignedIn(user) {
    const slot = document.getElementById("auth-slot");
    if (!slot) return;
    const label = user.email ? maskEmail(user.email) : "Signed in";
    slot.innerHTML = `
      <div class="auth-account">
        <span class="auth-name">${escapeHtml(label)}</span>
        <button type="button" class="auth-btn" id="auth-signout-btn">Sign out</button>
      </div>`;
    document.getElementById("auth-signout-btn").addEventListener("click", () => sync.signOut());
  }

  function closePopover() {
    if (popoverEl) popoverEl.classList.add("hidden");
  }

  function emailVal() {
    return document.getElementById("auth-email").value.trim();
  }

  function passwordVal() {
    return document.getElementById("auth-password").value;
  }

  function showAuthMessage(msg, isError) {
    const el = document.getElementById("auth-error");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
    el.classList.toggle("auth-error-ok", !isError);
  }

  function friendlyAuthError(err) {
    const code = (err && err.code) || "";
    if (code.includes("wrong-password") || code.includes("invalid-credential")) return "Incorrect email or password.";
    if (code.includes("user-not-found")) return "No account with that email.";
    if (code.includes("email-already-in-use")) return "An account with that email already exists.";
    if (code.includes("weak-password")) return "Password should be at least 6 characters.";
    if (code.includes("invalid-email")) return "That doesn't look like a valid email.";
    return "Something went wrong. Try again.";
  }

  async function runAuthAction(action, successMsg) {
    showAuthMessage("");
    try {
      await action();
      if (successMsg) showAuthMessage(successMsg, false);
      else closePopover();
    } catch (err) {
      showAuthMessage(friendlyAuthError(err), true);
    }
  }

  function openPopover() {
    if (popoverEl) {
      popoverEl.classList.remove("hidden");
      return;
    }
    popoverEl = document.createElement("div");
    popoverEl.id = "auth-popover";
    popoverEl.className = "auth-popover";
    popoverEl.innerHTML = `
      <button type="button" class="auth-close" aria-label="Close">✕</button>
      <button type="button" class="auth-google-btn" id="auth-google-btn">
        <svg class="google-g-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.8741 2.6836-6.615z"/>
          <path fill="#34A853" d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.8591-3.0477.8591-2.3441 0-4.3277-1.5831-5.0359-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"/>
          <path fill="#FBBC05" d="M3.9641 10.71c-.18-.54-.2823-1.1168-.2823-1.71s.1023-1.17.2823-1.71V4.9582H.9573C.3477 6.1731 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.9641 10.71z"/>
          <path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9641 7.29C4.6723 5.1627 6.6559 3.5795 9 3.5795z"/>
        </svg>
        <span>Sign in with Google</span>
      </button>
      <div class="auth-divider">or</div>
      <form id="auth-email-form">
        <input type="email" id="auth-email" placeholder="Email" required autocomplete="email">
        <input type="password" id="auth-password" placeholder="Password" required autocomplete="current-password">
        <div class="auth-error hidden" id="auth-error"></div>
        <div class="auth-actions">
          <button type="submit" class="auth-btn" id="auth-signin-btn">Sign in</button>
          <button type="button" class="auth-link" id="auth-signup-btn">Create account</button>
        </div>
        <button type="button" class="auth-link" id="auth-forgot-btn">Forgot password?</button>
      </form>`;
    document.body.appendChild(popoverEl);

    popoverEl.querySelector(".auth-close").addEventListener("click", closePopover);
    document.getElementById("auth-google-btn").addEventListener("click", () => {
      runAuthAction(() => sync.signInGoogle());
    });
    document.getElementById("auth-email-form").addEventListener("submit", ev => {
      ev.preventDefault();
      runAuthAction(() => sync.signInEmail(emailVal(), passwordVal()));
    });
    document.getElementById("auth-signup-btn").addEventListener("click", () => {
      runAuthAction(() => sync.signUpEmail(emailVal(), passwordVal()));
    });
    document.getElementById("auth-forgot-btn").addEventListener("click", () => {
      runAuthAction(() => sync.resetPassword(emailVal()), "Password reset email sent.");
    });

    document.addEventListener("click", function onOutsideClick(ev) {
      if (popoverEl.classList.contains("hidden")) return;
      if (ev.target.closest("#auth-popover") || ev.target.closest("#auth-open-btn")) return;
      closePopover();
    });
  }

  async function boot() {
    try {
      sync = await import("./firebase-sync.js");
      await sync.init();
    } catch (err) {
      console.warn("Firebase sync unavailable - sign-in disabled:", err);
      return;
    }

    renderSignedOut();

    sync.onAuthChange(user => {
      currentUser = user;
      closePopover();
      notifyAuthListeners();
      if (user) {
        renderSignedIn(user);
        reconcile(user);
      } else {
        renderSignedOut();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
