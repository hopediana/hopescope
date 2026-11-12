/* CUSTOMIZE HERE. Leave blank until you are ready to connect real content.
   Never put passwords, private API keys, or email service secrets in this file. */
const CONFIG = {
  formEndpoint: '', // Example: 'https://formspree.io/f/YOUR_FORM_ID'
  contactEmail: 'hopescopestudios@gmail.com',
  shutterClips: [], // Add supplied audio paths here to replace the temporary synthesized cycle.
  socials: { instagram: 'https://www.instagram.com/360hopescope/', linkedin: 'https://www.linkedin.com/in/HopeDiana/' }
};

'use strict';
document.documentElement.classList.add('js');
document.querySelector('#year').textContent = new Date().getFullYear();
let toastTimer;
function notify(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4500);
}

// Primary actions cycle through shutter sounds; small controls get a very soft click.
// The referenced video audio was unavailable; these synthesized variants are temporary.
let audioContext;
let soundOn = true;
try { soundOn = localStorage.getItem('hope-sound') !== 'off'; } catch (_) {}
const soundButton = document.querySelector('#sound');
const introSound = document.querySelector('#intro-sound');
function updateSound() {
  soundButton.setAttribute('aria-pressed', String(soundOn));
  soundButton.setAttribute('aria-label', `Shutter sound ${soundOn ? 'on, click to mute' : 'off, click to enable'}`);
  soundButton.querySelector('span').textContent = soundOn ? 'Sound on' : 'Sound off';
  introSound.setAttribute('aria-pressed', String(soundOn));
  introSound.textContent = soundOn ? 'Shutter sound on' : 'Shutter sound off';
}
let lastShutter = -Infinity;
let shutterIndex = 0;
const shutterProfiles = [
  {offsets:[0,.075], duration:.045, frequencies:[1100,1900], gain:.19},
  {offsets:[0,.045,.12], duration:.035, frequencies:[900,1700,700], gain:.16},
  {offsets:[0,.11], duration:.065, frequencies:[750,1450], gain:.18}
];
const shutterPlayers = CONFIG.shutterClips.map(path => {
  const player = new window.Audio(path); player.preload='auto'; player.volume=.65; return player;
});
function playSynthesized(profile) {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    audioContext ||= new Audio();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const now = audioContext.currentTime;
    profile.offsets.forEach((offset,index) => {
      const length=Math.floor(audioContext.sampleRate * profile.duration);
      const buffer=audioContext.createBuffer(1,length,audioContext.sampleRate);
      const data=buffer.getChannelData(0);
      for(let i=0;i<length;i++) data[i]=(Math.random()*2-1)*Math.exp(-i/(length/5));
      const source=audioContext.createBufferSource();source.buffer=buffer;
      const filter=audioContext.createBiquadFilter();filter.type='bandpass';
      filter.frequency.value=profile.frequencies[index];
      const gain=audioContext.createGain();gain.gain.value=profile.gain;
      source.connect(filter);filter.connect(gain);gain.connect(audioContext.destination);
      source.start(now+offset);
    });
  } catch (_) { /* Audio support never blocks the interface. */ }
}
function shutter() {
  if (!soundOn || performance.now()-lastShutter < 180) return;
  lastShutter=performance.now();
  const index=shutterIndex++;
  if (shutterPlayers.length) {
    shutterPlayers.forEach(player=>player.pause());
    const player=shutterPlayers[index % shutterPlayers.length];
    player.currentTime=0;
    player.play().catch(()=>playSynthesized(shutterProfiles[index % shutterProfiles.length]));
  } else playSynthesized(shutterProfiles[index % shutterProfiles.length]);
}
function quietClick() {
  if (!soundOn) return;
  playSynthesized({offsets:[0],duration:.012,frequencies:[1850],gain:.012});
}
updateSound();
soundButton.addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('hope-sound', soundOn ? 'on' : 'off'); } catch (_) {}
  updateSound();
  if (!soundOn) shutterPlayers.forEach(player=>player.pause());
  if (soundOn) quietClick();
});
document.addEventListener('click', event => {
  const control=event.target.closest('button,a,input,select,textarea');
  if (!control || control.closest('#sound, #intro-sound') || control.disabled) return;
  // The form's submit handler plays once after validation, including keyboard submit.
  if (control.matches('button[type="submit"]')) return;
  if (control.dataset.sound === 'shutter') shutter();
  else quietClick();
});

// Hash navigation works without a server and supports browser Back / Forward.
const pageNames = ['home', 'work', 'about', 'moments', 'contact'];
function route({initial = false} = {}) {
  const hash = location.hash.slice(1);
  const [pageKey, collection] = hash.split('/');
  const page = pageKey === 'moments-admin' ? 'moments' : pageNames.includes(pageKey) ? pageKey : 'home';
  const momentsFrame=document.querySelector('[data-moments-frame]');
  if(page==='moments' && pageKey==='moments-admin' && !momentsFrame.hasAttribute('srcdoc'))momentsFrame.src='/moments?embed=1&mode=admin';
  document.querySelectorAll('[data-view]').forEach(view => { view.hidden = view.dataset.view !== page; });
  document.querySelectorAll('[data-page]').forEach(link => {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if(momentsFrame.contentWindow)momentsFrame.contentWindow.postMessage({type:'hopescope-cursor-hide'},location.origin==='null'?'*':location.origin);
  document.title = `Hope Diana Jimenez — ${page === 'work' ? '360°hopescope / Work' : page === 'moments' ? 'Your Moments' : page[0].toUpperCase() + page.slice(1)}`;
  const targetId = page === 'work' && ['portraits','women-in-media','global-stage'].includes(collection) ? collection : hash === 'selected' ? 'selected' : null;
  if (targetId) {
    requestAnimationFrame(() => document.getElementById(targetId).scrollIntoView({behavior: initial ? 'instant' : 'smooth'}));
  } else window.scrollTo({top: 0, behavior: 'instant'});
  if (!initial) document.querySelector('#main').focus({preventScroll: true});
}
window.addEventListener('hashchange', () => route());
route({initial: true});

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); }
    });
  }, {threshold: .08});
  document.querySelectorAll('.reveal').forEach(item => observer.observe(item));
} else document.querySelectorAll('.reveal').forEach(item => item.classList.add('visible'));

document.querySelectorAll('[data-filter]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(other => {
      const active = other === button;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('.photo-card').forEach(card => {
      card.hidden = button.dataset.filter !== 'all' && card.dataset.category !== button.dataset.filter;
    });
  });
});
const dialog = document.querySelector('#lightbox');
document.querySelectorAll('.photo-card').forEach(card => {
  card.addEventListener('click', () => {
    const photo = card.querySelector('img');
    dialog.querySelector('img').src = photo.getAttribute('src');
    dialog.querySelector('img').alt = photo.alt;
    document.querySelector('#lightbox-caption').textContent = card.dataset.caption;
    dialog.showModal();
    dialog.append(document.querySelector('#ladybug-pointer'));
    document.body.style.overflow = 'hidden';
  });
});
dialog.querySelector('.close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { document.body.style.overflow = ''; document.body.append(document.querySelector('#ladybug-pointer')); });

// Connect real social destinations once your profiles are ready.
document.querySelectorAll('[data-social]').forEach(link => {
  const destination = CONFIG.socials[link.dataset.social];
  if (destination) {
    link.href = destination;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', link.dataset.social === 'instagram' ? 'Instagram @360hopescope' : link.dataset.social);
  } else {
    link.addEventListener('click', event => {
      event.preventDefault(); notify('Social profile placeholder — your link will go here.');
    });
  }
});
const form = document.querySelector('#contact-form');
const status = document.querySelector('#form-status');
if (CONFIG.formEndpoint) status.textContent = 'Your email is used only to respond to your inquiry.';
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  // Play one primary-action sound after validation, for mouse or keyboard submit.
  shutter();
  if (!CONFIG.formEndpoint) {
    const name = form.elements.namedItem('name').value.trim();
    const email = form.elements.namedItem('email').value.trim();
    const project = form.elements.namedItem('project').value;
    const message = form.elements.namedItem('message').value.trim();
    const subject = project ? `Photography inquiry: ${project}` : 'Photography inquiry';
    const body = `Name: ${name}\nReply to: ${email}\nProject: ${project || 'Not specified'}\n\n${message}`;
    window.location.href = `mailto:${CONFIG.contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    status.textContent = `Your email app has been requested. Review and send your draft there. If it did not open, email ${CONFIG.contactEmail} directly. Your message is still here.`;
    return;
  }
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  status.textContent = 'Sending your note…';
  try {
    const response = await fetch(CONFIG.formEndpoint, {
      method: 'POST', body: new FormData(form), headers: {Accept: 'application/json'}
    });
    if (!response.ok) throw new Error('Unable to send');
    status.textContent = 'Thank you! Your message has been sent.';
    form.reset();
  } catch (_) {
    status.textContent = 'Your message could not be sent. Please try again. Your text is still here.';
  } finally { button.disabled = false; }
});

// The opening iris is shown on each fresh visit. Navigation never replays it.
const intro = document.querySelector('#lens-intro');
const enter = document.querySelector('#enter-site');
const siteRegions = [document.querySelector('.skip'), document.querySelector('.header'), document.querySelector('main'), document.querySelector('footer')];
intro.hidden = false;
siteRegions.forEach(region => { region.inert = true; });
document.body.classList.add('intro-active');
enter.focus({preventScroll:true});
intro.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  if (event.shiftKey && document.activeElement === enter) {
    event.preventDefault(); introSound.focus();
  } else if (!event.shiftKey && document.activeElement === introSound) {
    event.preventDefault(); enter.focus();
  }
});
introSound.addEventListener('click', () => {
  soundOn = !soundOn;
  try {localStorage.setItem('hope-sound', soundOn ? 'on' : 'off');} catch (_) {}
  updateSound();
  if (!soundOn) shutterPlayers.forEach(player=>player.pause());
  if(soundOn) quietClick();
});
enter.addEventListener('click', () => {
  if (intro.classList.contains('opening')) return;
  intro.classList.add('opening');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    intro.hidden = true;
    document.body.classList.remove('intro-active');
    siteRegions.forEach(region => {region.inert=false;});
    document.querySelector('#main').focus({preventScroll:true});
    if (location.hash.startsWith('#work/')) route({initial:true});
  }, reduce ? 0 : 1400);
});

// The gallery panel is served by this same website, inside Your Moments.
const momentsFrame=document.querySelector('[data-moments-frame]');
let momentsModalScroll=null;
window.addEventListener('message',event=>{
  if(event.source!==momentsFrame.contentWindow || event.origin!==location.origin)return;
  const data=event.data;
  if(!data || typeof data!=='object')return;
  if(data.type==='hopescope-moments-height' && Number.isFinite(data.height)){
    const height=Math.min(30000,Math.max(450,Math.ceil(data.height)));
    if(momentsFrame.height!==String(height)){momentsFrame.height=String(height);momentsFrame.style.height=height+'px';}
  }
  if(data.type==='hopescope-moments-modal'){
    momentsModalScroll=window.scrollY;momentsFrame.scrollIntoView({block:'start',behavior:'instant'});
  }
  if(data.type==='hopescope-moments-modal-close' && momentsModalScroll!==null){
    window.scrollTo({top:momentsModalScroll,behavior:'instant'});momentsModalScroll=null;
  }

});
