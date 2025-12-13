# reset_db.py

from app import app, db, create_demo_data

# We need an application context so SQLAlchemy knows which app to use
with app.app_context():
    print("Dropping all tables...")
    db.drop_all()

    print("Creating tables again...")
    db.create_all()

    print("Seeding demo data...")
    create_demo_data()

    print("✅ Database has been fully reset.")
