/* Minimal JS — nav scroll state + subtle entrance animations */

// ── Nav scroll tint ──
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// ── Intersection entrance animations ──
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

const animTargets = document.querySelectorAll(
  '.feature-card, .step, .provider-card, .plan, .companion-mockup'
);
animTargets.forEach((el, i) => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = `opacity 500ms ease ${i * 60}ms, transform 500ms ease ${i * 60}ms`;
  observer.observe(el);
});

// ── Hero screenshot fallback (if file not found, hide gracefully) ──
const heroImg = document.getElementById('hero-img');
if (heroImg) {
  heroImg.onerror = () => {
    heroImg.style.display = 'none';
    document.querySelector('.screen-body').style.minHeight = '0';
  };
}
