// Contacts page
// Simple page with contact information and sign out

document.addEventListener('DOMContentLoaded', function() {
  const signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', function() {
      handleSignOut();
    });
  }
});

function handleSignOut() {
  // Clear auth token
  try {
    localStorage.removeItem('auth_token');
    sessionStorage.removeItem('auth_token');
  } catch (e) {}

  // Redirect to login
  window.location.href = 'index.html';
}
