async function submitAuth(form,type){
 const msg=document.getElementById("authMessage");
 msg.textContent=type==="login"?"Signing in...":"Creating account...";
 const body=type==="login"
 ? {email:document.getElementById("email").value,password:document.getElementById("password").value}
 : {name:document.getElementById("name").value,email:document.getElementById("email").value,password:document.getElementById("password").value};
 try{const r=await fetch(`/api/${type}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok){msg.textContent=d.message;return}window.location.href="dashboard.html"}catch(e){msg.textContent="Unable to connect to VaultQ."}
}
const lf=document.getElementById("loginForm");if(lf)lf.addEventListener("submit",e=>{e.preventDefault();submitAuth(lf,"login")});
const rf=document.getElementById("registerForm");if(rf)rf.addEventListener("submit",e=>{e.preventDefault();submitAuth(rf,"register")});
