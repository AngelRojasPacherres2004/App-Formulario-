import base64
import os
import streamlit as st

@st.cache_data
def _get_base64_video(video_path: str) -> str | None:
    """Lee un archivo de video y lo devuelve en formato base64."""
    try:
        if os.path.exists(video_path):
            with open(video_path, "rb") as f:
                return base64.b64encode(f.read()).decode()
    except Exception:
        pass
    return None

def apply_styles():
    """
    Aplica estilos personalizados CSS a la aplicación.
    """
    st.markdown("""
        <style>
            /* Fondo general de la aplicación */
            .stApp {
                background-image: url("https://images.unsplash.com/photo-1497366216548-37526070297c?q=80&w=2069&auto=format&fit=crop");
                background-size: cover;
                background-position: center;
                background-attachment: fixed;
                background-repeat: no-repeat;
            }
            
            /* Contenedor principal con fondo semi-transparente para legibilidad */
            .main .block-container {
                background-color: rgba(255, 255, 255, 0.8);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                padding: 3rem;
                border-radius: 1rem;
                margin-top: 1.5rem;
                box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            }

            /* Estilo para el contenido de los expanders (como los detalles de trabajador) */
            [data-testid="stExpanderContent"] {
                background-color: rgba(255, 255, 255, 0.7); /* Un poco más transparente que el main container */
                backdrop-filter: blur(8px); /* Un blur ligeramente diferente o igual */
                -webkit-backdrop-filter: blur(8px);
                border-radius: 0.5rem; /* Bordes redondeados para el contenido */
                padding: 1rem; /* Espaciado interno */
                margin-top: 0.5rem; /* Separación del encabezado del expander */
            }

            /* Estilo personalizado para el Sidebar */
            [data-testid="stSidebar"] {
                background-color: rgba(255, 255, 255, 0.15);
                backdrop-filter: blur(12px);
                border-right: 2px solid #1e3a8a;
                padding-top: 1rem;
            }
            
            /* Títulos */
            h1, h2, h3 {
                color: #1e3a8a;
                font-weight: bold;
            }
            
            /* Botones */
            .stButton > button {
                border-radius: 5px;
                transition: 0.2s;
                font-weight: 600;
            }

            .stButton > button:hover {
                border: 1px solid #1e3a8a;
            }
            
            /* Input Fields */
            .stTextInput > div > div > input {
                border-radius: 6px;
            }
            
            /* Estilo de los bloques de información (st.info) */
            .stAlert {
                border-radius: 10px;
                border: none;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
            }
            
            /* Métricas */
            [data-testid="stMetricValue"] {
                color: #1e3a8a;
            }

            /* Divisores */
            hr {
                margin-top: 1rem;
            }
        </style>
    """, unsafe_allow_html=True)

def add_login_video_background(video_file: str = "fondovideo.mp4"):
    """
    Añade un video de fondo para la pantalla de login.
    """
    video_b64 = _get_base64_video(video_file)
    if video_b64:
        st.markdown(f"""
            <style>
                #bgVideo {{
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    z-index: -1;
                    filter: brightness(0.5);
                }}
                .stApp {{
                    background: none !important;
                }}
            </style>
            <video autoplay muted loop id="bgVideo">
                <source src="data:video/mp4;base64,{video_b64}" type="video/mp4">
            </video>
        """, unsafe_allow_html=True)