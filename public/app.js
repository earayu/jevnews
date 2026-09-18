(() => {
  // Optional enhancements only. Reading, forms and More work without JavaScript.
  try {
    const hidden = new Set(JSON.parse(localStorage.getItem('jev.hidden') || '[]'));
    const saved = new Set(JSON.parse(localStorage.getItem('jev.saved') || '[]'));
    const apply = () => document.querySelectorAll('[data-item]').forEach(el => { if(hidden.has(el.dataset.item)) el.hidden = true; });
    apply();
    document.querySelectorAll('[data-local]').forEach(button => button.addEventListener('click', () => {
      const id=button.dataset.id;
      if(button.dataset.local==='hide'){hidden.add(id);localStorage.setItem('jev.hidden',JSON.stringify([...hidden].slice(-2000)));apply();}
      else {saved.add(id);localStorage.setItem('jev.saved',JSON.stringify([...saved].slice(-2000)));button.textContent='saved locally';}
    }));
    const localList=document.getElementById('local-state');
    if(localList){const kind=localList.dataset.state;const entries=kind==='hidden'?hidden:saved;
      for(const id of [...entries].reverse()){
        if(!/^\d+$/.test(id))continue;
        const li=document.createElement('li'),link=document.createElement('a'),remove=document.createElement('button');
        link.href='/item?id='+id;link.textContent='HN item #'+id;remove.textContent='remove';
        remove.addEventListener('click',()=>{entries.delete(id);localStorage.setItem('jev.'+kind,JSON.stringify([...entries]));li.remove();});
        li.append(link,' ',remove);localList.append(li);
      }
      if(!entries.size)localList.textContent='Nothing stored in this browser.';
    }
    const form=document.querySelector('form.controls');
    if(form)form.addEventListener('submit',()=>localStorage.setItem('jev.preset',form.elements.preset.value));
  } catch { /* Private browsing/storage denial must not break reading. */ }
  const feed=document.querySelector('[data-feed]');
  if(feed){setInterval(async()=>{if(document.hidden)return;try{const r=await fetch('/api/feed-version?view='+encodeURIComponent(feed.dataset.feed),{cache:'no-store'});if(r.ok){const data=await r.json();if(data.id&&data.id!==feed.dataset.version)document.getElementById('feed-update').hidden=false;}}catch{}},120000);}
})();
