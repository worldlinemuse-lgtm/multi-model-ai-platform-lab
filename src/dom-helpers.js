// Pure DOM helpers, moved verbatim from main.js (Stage 4b group 1).
// No app state, no side effects beyond the DOM calls themselves.
export const el=id=>document.getElementById(id);
export const qs=s=>document.querySelector(s);
export const qsa=s=>Array.from(document.querySelectorAll(s));
export const $=el;
export function make(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node;}
export function clearNode(node){node.replaceChildren();return node;}
export function formatTime(t){try{return new Date(t).toLocaleString()}catch{return String(t)}}
export function errorText(e){return typeof e==='string'?e:e?.message||String(e);}
