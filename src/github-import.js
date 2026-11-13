/* GitHub repo import (Stage A). Pure logic plus a fetch-injected loader.
 *
 * Why the GitHub API, not the repo ZIP: codeload (and the api.github.com
 * zipball redirect into it) answers with Access-Control-Allow-Origin:
 * https://render.githubusercontent.com only, so a browser fetch from this
 * page's origin is CORS-blocked — verified live 2026-11-13. The GitHub
 * REST API git-trees endpoint and raw.githubusercontent.com both answer
 * Access-Control-Allow-Origin: *, so a public repo can be pulled straight
 * from GitHub in the browser: two API calls (repo for the default branch,
 * one recursive tree) and one raw fetch per file. No key, no proxy.
 * Unauthenticated API calls share GitHub's 60/hour limit; file fetches
 * go to raw.githubusercontent.com and do not count against it.
 * If any of it is blocked, the caller is told in plain language to
 * download the ZIP from GitHub and drop it on the existing Import button.
 */
import {safeFiles} from './core.js';
import {binaryRecord,validateBinaryAssets,BINARY_TYPES,binaryExtension} from './binary-assets.js';

export const GITHUB_MAX_ENTRIES=128;
export const GITHUB_MAX_TOTAL_BYTES=2500000;
export const GITHUB_MAX_FILE_BYTES=500000;
const ZIP_FALLBACK='download the ZIP from GitHub and drop it on Import instead';
const OWNER_REPO=/^[A-Za-z0-9_.-]+$/;

export function parseGitHubRepoUrl(raw){
 let url;
 try{url=new URL(String(raw||'').trim());}catch{throw Error('Paste a GitHub repo link like https://github.com/owner/repo.');}
 if(!['http:','https:'].includes(url.protocol)||url.hostname.toLowerCase()!=='github.com')
  throw Error('Paste a GitHub repo link like https://github.com/owner/repo — that link is not github.com.');
 const parts=url.pathname.split('/').filter(Boolean);
 if(parts.length<2||!OWNER_REPO.test(parts[0])||!OWNER_REPO.test(parts[1].replace(/\.git$/,'')))
  throw Error('Paste a GitHub repo link like https://github.com/owner/repo — the owner or repo name is missing.');
 const repo=parts[1].replace(/\.git$/,'');
 if(parts.length>2&&parts[2]!=='tree')
  throw Error('Paste a GitHub repo link like https://github.com/owner/repo — only repo links and /tree/ links open here.');
 if(parts.length>2)return {owner:parts[0],repo,branch:parts[3],subpath:parts.slice(4).join('/')};
 return {owner:parts[0],repo,branch:null,subpath:''};
}

// GitHub ZIPs wrap everything in one top-level folder (repo-branch/...).
// Strip it when every entry shares it, so index.html lands at the root.
export function stripTopLevelFolder(entries){
 const names=Object.keys(entries);
 if(!names.length||!names.every(n=>n.includes('/')))return entries;
 const first=names[0].split('/')[0];
 if(!names.every(n=>n.split('/')[0]===first))return entries;
 return Object.fromEntries(names.map(n=>[n.slice(first.length+1),entries[n]]));
}

export function pickEntryFile(files){
 if(Object.hasOwn(files,'index.html'))return 'index.html';
 if(Object.hasOwn(files,'main.js'))return 'main.js';
 return Object.keys(files)[0];
}

function isHidden(path){return path.split('/').some(part=>part.startsWith('.'));}

export function filterGitHubTreeEntries(tree,subpath=''){
 const kept=[],skipped=[];
 let total=0;
 for(const entry of tree||[]){
  if(!entry||entry.type==='tree')continue;
  if(entry.type==='commit'){skipped.push({path:entry.path,reason:'a link to another repo, not copied'});continue;}
  if(entry.type!=='blob')continue;
  if(subpath&&!(entry.path===subpath||entry.path.startsWith(subpath+'/')))continue;
  const path=subpath?entry.path.slice(subpath.length+1):entry.path;
  if(isHidden(path)){skipped.push({path,reason:'inside a hidden folder or file, not part of the project'});continue;}
  const size=Number.isSafeInteger(entry.size)?entry.size:0;
  if(size>GITHUB_MAX_FILE_BYTES){skipped.push({path,reason:`bigger than the 500 KB file limit (${Math.round(size/1000)} KB)`});continue;}
  total+=size;
  kept.push({path,size});
 }
 if(kept.length>GITHUB_MAX_ENTRIES)throw Error(`That repo has too many files for one project here (${GITHUB_MAX_ENTRIES} at most). Download the ZIP from GitHub and drop it on Import instead.`);
 if(total>GITHUB_MAX_TOTAL_BYTES)throw Error('That repo is too big for one project here (2.5 MB of files at most). Download the ZIP from GitHub and pick the files you need, or open a smaller folder link.');
 return {kept,skipped};
}

async function fetchJson(fetchImpl,url){
 let res;
 try{res=await fetchImpl(url);}catch{throw Error(`Couldn't reach GitHub from this browser. Check your connection, or ${ZIP_FALLBACK}.`);}
 let body=null;
 try{body=await res.json();}catch{body=null;}
 return {res,body};
}

export async function fetchGitHubRepo(rawUrl,{fetchImpl=fetch}={}){
 const parsed=parseGitHubRepoUrl(rawUrl);
 const {owner,repo}=parsed;
 const apiBase=`https://api.github.com/repos/${owner}/${repo}`;
 const treeUrl=(branch)=>`${apiBase}/git/trees/${branch.split('/').map(encodeURIComponent).join('/')}?recursive=1`;
 let branch=parsed.branch,subpath=parsed.subpath,treeBody=null;
 if(branch){
  // Branch names may contain slashes, and a /tree/ link cannot say where
  // the branch ends and the folder begins — try longer prefixes until the
  // tree answers, and treat the rest as the folder path.
  const segments=[branch,...(subpath?subpath.split('/'):[])];
  for(let i=1;i<=segments.length;i++){
   const candidate=segments.slice(0,i).join('/');
   const {res,body}=await fetchJson(fetchImpl,treeUrl(candidate));
   if(res.status===404)continue;
   if(!res.ok)throw Error(`GitHub refused the request (${res.status}). Download the ZIP from GitHub and drop it on Import instead.`);
   branch=candidate;subpath=segments.slice(i).join('/');treeBody=body;break;
  }
  if(!treeBody)throw Error(`Couldn't find that branch or folder on GitHub. Check the link, or ${ZIP_FALLBACK}.`);
 }else{
  const {res,body}=await fetchJson(fetchImpl,apiBase);
  if(res.status===404)throw Error(`That repo doesn't exist or isn't public. Check the link, or ${ZIP_FALLBACK}.`);
  if(res.status===403&&(res.headers?.get?.('x-ratelimit-remaining')==='0'))
   throw Error(`GitHub's public hourly limit for this browser is used up. Try again later, or ${ZIP_FALLBACK}.`);
  if(!res.ok||!body?.default_branch)throw Error(`GitHub refused the request (${res.status}). Download the ZIP from GitHub and drop it on Import instead.`);
  branch=body.default_branch;
  const tree=await fetchJson(fetchImpl,treeUrl(branch));
  if(!tree.res.ok)throw Error(`Couldn't open that repo on GitHub (${tree.res.status}). Download the ZIP from GitHub and drop it on Import instead.`);
  treeBody=tree.body;
 }
 const {kept,skipped}=filterGitHubTreeEntries(treeBody?.tree,subpath);
 const files={},binaryAssets={};
 const rawBase=`https://raw.githubusercontent.com/${owner}/${repo}/${branch.split('/').map(encodeURIComponent).join('/')}`;
 for(const entry of kept){
  const repoPath=subpath?subpath+'/'+entry.path:entry.path;
  let res;
  try{res=await fetchImpl(rawBase+'/'+repoPath.split('/').map(encodeURIComponent).join('/'));}
  catch{skipped.push({path:entry.path,reason:'could not be downloaded'});continue;}
  if(!res.ok){skipped.push({path:entry.path,reason:`GitHub answered ${res.status} for this file`});continue;}
  const ext=binaryExtension(entry.path);
  if(BINARY_TYPES[ext]){
   try{binaryAssets[entry.path]=binaryRecord(entry.path,new Uint8Array(await res.arrayBuffer()));}
   catch(error){skipped.push({path:entry.path,reason:error.message});}
  }else{
   try{files[entry.path]=await res.text();}
   catch{skipped.push({path:entry.path,reason:'could not be read as text'});}
  }
 }
 if(!Object.keys(files).length)throw Error('That repo has no text files this lab can open. Download the ZIP from GitHub and pick the files you need.');
 if(!safeFiles(files))throw Error('That repo is too big for one project here (120 files or 1.25 MB of text at most). Download the ZIP from GitHub and pick the files you need, or open a smaller folder link.');
 if(!validateBinaryAssets(binaryAssets,files))throw Error('That repo has too much media for one project (8 files, 400 KB each, 1.25 MB total). Download the ZIP from GitHub and pick the files you need.');
 return {name:repo+(subpath?' / '+subpath:''),files,binaryAssets,active:pickEntryFile(files),skipped};
}
