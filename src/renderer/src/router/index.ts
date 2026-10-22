import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 本地音乐 is the home page: it owns the library, the statistics and the smart playlists.
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    // 在线音乐 is the search terminal (platforms only, no local library mixed in).
    { path: '/search', name: 'search', component: () => import('../views/SearchView.vue') },
    // Kept as aliases so an old bookmark or an in-app link still lands somewhere sensible.
    { path: '/online', redirect: '/search' },
    { path: '/library', redirect: '/' },
    { path: '/playlists', name: 'playlists', component: () => import('../views/PlaylistsView.vue') },
    { path: '/favorites', name: 'favorites', component: () => import('../views/FavoritesView.vue') },
    { path: '/history', name: 'history', component: () => import('../views/HistoryView.vue') },
    { path: '/downloads', name: 'downloads', component: () => import('../views/DownloadsView.vue') },
    { path: '/playlist/:id', name: 'playlist', component: () => import('../views/PlaylistView.vue') },
    { path: '/lyrics', name: 'lyrics', component: () => import('../views/LyricsView.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
    { path: '/settings/sources', name: 'settings-sources', component: () => import('../views/SourcesSettingsView.vue') },
    // One source, one page: its own health, hosts, config and self-check, independent of the others.
    { path: '/settings/sources/:id', name: 'source-detail', component: () => import('../views/SourceDetailView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
